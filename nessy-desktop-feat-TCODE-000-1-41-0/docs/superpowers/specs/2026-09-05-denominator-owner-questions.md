# Denominator sweep — owner questions (2026-09-05)

Produced by P6.190 (Workflow: 19 compose slices over the 525 in-scope denominator entries, stitched, critic-checked 2026-09-05). 75 questions grouped by runtime, each with the ledger ids it closes, 2–4 options (buys/costs) and a recommendation; pointers where the sitting page or `2026-09-05-ledger-closure-owner-questions.md` already asks it. Triage under the owner's 2026-09-02 delegation is recorded per question by the controller (DECIDED / OWNER / POINTER).

# Denominator owner questions — stitched (ledger groups A–O)

Every question from the 19 per-slice `questions-<L>-<k>.md` files, regrouped by the `[<runtime>]` tag in its
heading. Bodies — including every option's *buys* and *costs*, every recommendation and every parity direction —
are **verbatim**; nothing was rewritten, shortened or re-optioned.

- New questions: **75**. Pointer entries kept as one-liners: **1**.
- Cross-group merges performed: **0**. No ledger id is claimed by two questions (71 distinct ids over 76 headings,
  checked against each question's own *Closes* clause), so no two questions are the same decision asked twice.
  The adjacent-but-distinct pairs that were checked and deliberately NOT merged are listed at the end.
- Three slices (`D#0`, `J#1`, `O#0`) raise no new question; their reasoning is kept under
  **Slices with no new question**, and their pointers are merged into **Already asked**.

## Host

### [host] What permission mode does a reopened session start in?

*(denominator slice A#0)*

*(Denominator A17 — pi `partial`, claude `partial`, codex `partial`; size S. Ours: the mode manager is
host-side, and no runtime restores this for us — the claude SDK is spawned per session with the mode we
pass, and codex likewise.)*

Today a session is restored into whatever mode it ended in. `packages/server-core/src/sessions/SessionManager.ts` symbol `normalizePersistedSessionPermissionMode`
`normalizePersistedSessionPermissionMode` → `:10853` `setPermissionMode(..., { changedBy: 'restore' })`;
the only clamp, `clampArrivingBypassForHost` (`:26012-26022`), fires ONLY when the host refuses bypass
(root/sudo outside a container), so on an ordinary desktop a session that ended in `bypassPermissions`
**reopens in it**, which the page's first resume-table row forbids. `plan` is restored unchanged and
`auto` gets no eligibility re-check. `normalizeSessionPermissionMode` (`:25993-25997`) carries a Pi-only
branch, so the three runtimes are not even identical today.

- **A. Follow the page's resume table** — buys: `bypassPermissions` and `plan` are never silently
  restored and `auto` is re-checked against current eligibility, so reopening a chat can never be more
  permissive than opening a new one — costs: a user who deliberately ended in plan mode must re-enter it;
  the app remembers less than it used to.
- **B. Keep today's full restore** — buys: session intent survives verbatim on all three, and no code
  changes — costs: a session that ended in `bypassPermissions` reopens in it on an ordinary desktop, and
  nothing catches it; this is a silent widening across a restart.
- **C. Split — bypass and auto follow the page, `plan` is restored** — buys: the dangerous half is fixed
  and the harmless intent is kept — costs: our resume behaviour differs from the documented table in one
  named row, which must be written into the mode picker's runtime clause.

**Recommendation:** C. It takes A's safety on the two modes that matter and B's intent on the one that
does not, at the price of one stated divergence.

**Closes the difference:** A closes it against the documented contract on all three runtimes; C closes it
except for `plan` and owes one honest sentence; B does not close it.

### [host] May a developer widen the judge's trust boundary on their own machine?

*(denominator slice A#0)*

*(Denominator A33 — pi `partial`, claude `partial`, codex `partial`; size M. Also gates the editor half of
the permissions/judge surface row and the shape of the managed-only `autoMode` tripwire.)*

The page lets a user name the repos, source-control orgs, buckets, domains, registries and services their
organisation trusts, splicing `"$defaults"` to keep the built-ins (`auto-mode-config.md:64,76,100`). We
implement the managed scope only, and deliberately: `AUTO_MODE_KEYS = ['environment','hard_deny',
'soft_deny','allow']` parsed entry-by-entry from the managed policy (`managed-policy.ts:841`, `:843`), a
fixed host-built list on claude (`claude-auto-mode-policy.ts:254`, `:303/:332/:345`, `:366-376`), and on
codex a real but empty free-text channel we already wire (`config-defaults-schema.ts:61-67`,
`packages/shared/src/agent/codex-agent.ts` symbol `buildCodexAutoReviewOptions`; codex's own
`packages/codex-protocol/schema/config-schema.json` symbol `AutoReviewToml` declares exactly one
property, `policy: string`). There is no
user scope and no UI anywhere (`git grep -ain autoMode -- packages/shared/src/config apps/electron/src
packages/ui` → one unrelated test comment).

- **A. Managed scope only — today's shape** — buys: a repository, a build step or a compromised toolchain
  can never widen what the judge trusts, matching the two sites that already say so in comments — costs:
  the page's own user scope is unimplemented on all three; a developer's own registry has to go through an
  administrator, every turn until then.
- **B. User scope, additive, with `"$defaults"` splicing as the page specifies** — buys: documented
  parity, and the judge stops flagging a developer's own hosts — costs: the trust boundary of a safety
  judge becomes user-writable; the page itself warns about this, and a file write is the cheapest thing an
  attacker gets.
- **C. User scope for `hard_deny`/`soft_deny` only (narrowing), managed-only for `allow`/`environment`** —
  buys: a developer can make the judge stricter and never looser, which is the same
  direction-of-strictness contract the fork already applies to managed settings (ledger A8) — costs: a
  documented key half-honoured, and the asymmetry must be stated at the settings surface.

**Recommendation:** C. It is the only option that cannot loosen a judge, and it reuses a rule this tree
already has rather than inventing one.

**Closes the difference:** B closes it against the page; C closes the half that does not trade safety; A
does not close it and owes the honest surface instead.

### [host] Accept Edits: four filesystem commands, or the page's six?

*(denominator slice A#0)*

*(Denominator A37 — pi `partial`, claude `partial`, codex `partial`; size S. Host-side gate, one set for
all three runtimes — the same `pre-tool-use.ts` ledger A2 records as covered.)*

Two vendor pages disagree and our record answers the question twice, oppositely.
`packages/shared/src/agent/core/pre-tool-use.ts` symbol `ACCEPT_EDITS_FILESYSTEM_COMMANDS` is `const ACCEPT_EDITS_FILESYSTEM_COMMANDS = new Set(['mkdir','touch','mv','cp'])`,
whose docblock directly above it cites `agent-sdk/agent-loop.md`'s four-item "etc." list and adds "The etc.
is not an invitation to invent entries." `security.md:34` names six, adding `rm` and `sed`. Meanwhile
`2026-08-02-claude-doc-sweep-divergences.md:478` calls the four "a recorded bank decision, not a defect",
while `2026-08-28-claude-sweep-triage.md` F98.3 marks it TAKE · never looked at, its evidence line reading
"NOT MEASURED in this pass".

- **A. Keep four (`mkdir`, `touch`, `mv`, `cp`)** — buys: Accept Edits never auto-approves an unattended
  deletion or an in-place rewrite; `rm` and `sed` keep prompting — costs: a documented six-item list is
  honoured as four on all three runtimes, and that must be stated in the mode description.
- **B. Adopt all six** — buys: exact parity with `security.md`, and a user who chose Accept Edits stops
  being asked about the edits they asked for — costs: `rm` under Accept Edits is unattended deletion
  inside the working directory, which is the one class the fork's own floors exist to slow down.

**Recommendation:** A — and settle the record in the same pass, because two live documents currently give
opposite answers and the next lane will read whichever it finds first.

**Closes the difference:** B closes it as parity; A keeps it and owes one sentence in the mode description
plus a corrected record.

### [host] Adopt the vendor's confirmation-suppression switches, or refuse them by name?

*(denominator slice A#0)*

*(Denominator A38 — pi `absent`, claude `partial`, codex `absent`; size not scored by the sweep.)*

`skipDangerousModePermissionPrompt` IS in the vendored bundle (`grep -aoF` → 1; controls `Cookie` → 5,
`git-subdir` → 4) and reachable from a **project** settings file, because we pass
`settingSources: ['user','project','local']` (`packages/shared/src/agent/claude-agent.ts` symbol `settingSources`). So today a repository can suppress
the dangerous-mode confirmation on a claude session and nowhere else. Its auto-mode twin
`skipAutoPermissionPrompt` is absent from the bundle (→ 0) and appears in our tree only in two test files.
We implement neither (`git grep -ail -F skipDangerousModePermissionPrompt` over `:(glob)packages/**`
`:(glob)apps/**` → 0 files) — the confirmation is ours on Pi and codex.

- **A. Implement host-side, uniformly on all three** — buys: one behaviour instead of a key that works
  only on claude sessions, and an operator who suppresses the dialog gets what they configured — costs: we
  ship a supported way to remove a safety confirmation, reachable from a project settings file, i.e. from
  a repository.
- **B. Refuse by name and block the SDK key** — buys: the dangerous-mode confirmation cannot be suppressed
  by any file on any runtime, and the current claude-only asymmetry disappears in the safe direction —
  costs: a documented vendor key stops working on claude, which must be named where the refusal happens.
- **C. Honour it from the managed scope only** — buys: a deployment that has already decided can suppress
  the dialog, while a repository cannot — costs: a third scope rule to keep true, and the confirmation is
  still removable.

**Recommendation:** B for the project and local scopes at minimum, because today's reachable path is the
repository one; C on top if the operator case is real.

**Closes the difference:** A closes it as parity and pays with a repository-reachable safety-prompt
removal; C closes it in the safe direction; B closes it by removing the capability everywhere and owes a
named refusal.

### [host] A subagent's declared permission mode: clamp it (ours) or ignore it (the page)

*(denominator slice A#1)*

**Closes:** Denominator A58 — pi `partial`, claude `partial`, codex `partial` (one shared host mechanism,
so the answer lands on all three at once).

`agent-sdk/permissions.md:119` says a subagent's declared permission mode is **ignored** when the parent
session is in `auto`, `acceptEdits` or `bypassPermissions`. Ours **clamps**: `requestedRank <= parentRank
? requested : parent`, with one hand-written carve-out for the incomparable `plan`/`explore` pair. So a
child may run NARROWER than such a parent — a deviation in the safe direction, and undeclared anywhere a
user or an operator reads.

- **A — record the deviation, change no code** — buys: the safe direction is kept (a subagent can only
  ever be tighter than its parent), costs nothing, and one written deviation makes it honest; the
  carve-out stays where a reader can find it. — costs: we knowingly diverge from the page on a
  permission surface, so the next lane reading the page will "fix" it again unless the deviation is
  pinned by a test.
- **B — match the page: ignore the child's declared mode under those three parents** — buys: exact
  conformance with the documented contract, and one fewer place where our permission semantics differ
  from what a Claude-shaped plugin or agent definition expects. — costs: it **LOOSENS** what a subagent
  may do — an agent definition that deliberately declares `plan` would start running with the parent's
  `bypassPermissions`; that is a real safety regression bought for conformance.

**Recommendation:** **A** — record the deviation, pin it with a test, and say so in the agent-definition
docs. Conformance is not worth loosening a permission floor, and the page's own narrower twin
(`permission-modes.md:467`, auto-mode subagents only) shows the contract is not settled upstream either.

**Parity direction.** Neither option changes a cross-runtime difference: the clamp is host-side and shared
by all three, so this is host-vs-page, not runtime-vs-runtime. **B closes the difference with the page;
A closes it with a declaration.**

**Evidence:** `agent-sdk/permissions.md:119` (the sentence scores 0 in `permission-modes.md`; that page's
own narrower version is at `:467`); implementation `mode-types.ts:156-166`, carve-out at `:164`;
`runtime-agent-definitions.ts:420` forwards `descriptor.permissionMode`;
`packages/pi-agent-server/README.md` §"Definition schema" (the `permissionMode` row) "Invalid values warn-and-ignore to inheriting the parent".

### [host] May an untrusted MCP server's `readOnlyHint` let its tool skip our gate?

*(denominator slice A#1)*

**Closes:** Denominator A74 — pi `absent`, claude `absent`, codex `absent`.

Codex HAS the mechanism (`default_tools_approval_mode` per server, `approval_mode` per tool) and our
writer emits neither, deliberately. Claude has the ANNOTATION and no approval axis on it. Native-first
cannot simply be taken here for two independent reasons: user MCP servers reach codex as ONE aggregated
`[mcp_servers.sources]` proxy, so codex's per-server key cannot address a user's individual server; and
our own recorded invariant says a tool annotation is *"ADVISORY ONLY … a hint from a possibly untrusted
server and must never become an authorization signal"* — test-pinned. The narrowing counterpart is
already built and states the asymmetry: it is admissible *"only because it can exclusively NARROW
access."* So honouring `readOnlyHint` to SKIP a prompt reverses a pinned invariant in the loosening
direction — an owner call, not a lane's.

- **A — keep the invariant; write the deviation** — buys: an untrusted server can never lower its own
  gate; one written deviation explains why a documented codex capability is unemitted. — costs: users
  keep approving read-only MCP calls one at a time on every runtime; a real ergonomic cost that pushes
  people toward blanket allow rules, which is the worse outcome.
- **B — honour the hint only for operator-allowlisted servers** — buys: the ergonomics where the trust
  already exists (the operator, not the server, is the authority), and it composes with codex's own
  per-server key for the servers that are addressable; the invariant survives for everything else. —
  costs: a new allowlist surface and its managed-policy key; the aggregation problem means the codex arm
  is host-side anyway, so the mechanism is ours to maintain on all three.

**Recommendation:** **B**, scoped so the allowlist is operator-owned and empty by default — never a
blanket writes mode, and never the hint alone. If B is not funded, take **A** and write the deviation.

**Parity direction.** **B closes the difference** on all three at once (host-side, so uniform by
construction) and is the only option that lets codex's native per-server key ever be emitted. **A does
not close it; it declares it.**

**Evidence:** `packages/shared/src/mcp/mcp-pool.ts:470-476` (the advisory-only invariant), pinned by
`packages/shared/src/mcp/__tests__/proxy-tool-names.test.ts` anchor `does not project advisory protocol metadata into authorization fields`; the narrowing counterpart
`packages/shared/src/mcp/mcp-pool.ts` symbol `interactionRequiredProxyToolNames`; annotations carried at `mcp-pool.ts:1525`,
`:2903`, `pool-server.ts:436` with no permission path reading them; codex side —
`default_tools_approval_mode` 4 hits and per-tool `approval_mode` 6 hits in
`packages/codex-protocol/schema/config-schema.json`, absence pinned with a positive control at
`packages/codex-responses-adapter/src/__tests__/config-writer.test.ts:263-271` and its reason in the plan
at `:2632` (T5); claude — `readOnlyHint` occurs once in the vendored `sdk.mjs`; page `extend/mcp` (row 67).

### [host] A second permission authority: approving a tool prompt from a phone over a channel

*(denominator slice A#1)*

**Closes:** Denominator A75 — `absent` on all three for the CHANNEL route.

`channels-reference` describes answering a tool-use prompt through a channel with the local dialog
staying live and the first answer winning. No runtime has it. The host already has a DIFFERENT remote
route — `RESPOND_TO_PERMISSION` is remote-eligible — so a channel relay would be a **second** authority
over the same decision, reachable by whoever is on a channel sender allowlist. The page also pins the
masking behaviour to CLI 2.1.234 while the bundle declares 2.1.233.

- **A — decline the channel route; keep `RESPOND_TO_PERMISSION` as the single remote authority** — buys:
  exactly one path that can answer a permission prompt, with one audit trail; no allowlist becomes a
  permission-granting credential; nothing is built against a page the bundle has not reached. — costs: a
  documented capability stays absent; a user away from the machine uses the existing remote route or
  nothing.
- **B — relay, behind a per-source opt-in that is off by default** — buys: the documented ergonomics, and
  the first-answer-wins race is the page's own design, so the semantics are specified rather than
  invented. — costs: a second authority over the safety decision; the opt-in becomes a security control
  that must be managed-policy-gated, audited and switch-reported on three runtimes; and it would be
  built against a contract our bundle is one patch version short of.

**Recommendation:** **A**, at least while the bundle declares 2.1.233. Re-ask when the bundle reaches
2.1.234 and the masking behaviour can be read rather than assumed.

**Parity direction.** **B closes the difference** with the page, uniformly (host-side). **A declares it**
and keeps one authority. Note that A is also the status quo on all three runtimes, so it opens no new
runtime-to-runtime divergence.

**Evidence:** `git grep -al 'channel/permission' -- packages apps` → 0 at `34be43fde` (control
`claude/channel` → 9); `protocol/channels.ts:44` `RESPOND_TO_PERMISSION`, in `REMOTE_ELIGIBLE_LIST`
`routing.ts:355` (set built `:626`); `2026-08-02-claude-doc-sweep-divergences.md:160` f137;
`claude-agent-sdk/package.json` `claudeCodeVersion 2.1.233`; page `channels-reference`.

### [host] Do we ship an environment-drafting assistant at all (`/auto-mode-setup`)?

*(denominator slice A#1)*

**Closes:** Denominator A79 — `absent` on all three.

Claude ships `/auto-mode-setup`: it drafts a user's `autoMode` allow entries by reading the project, the
user's recent sessions and — optionally — their shell history and home-directory repositories, and it
writes `~/.claude/settings.json`. It is present in the vendored binary and unreachable from our app: a
CLI slash command whose surface we do not expose, writing a file that is not our config. Pi and codex
have nothing equivalent. So this is not a projection decision; it is whether we build the feature.

- **A — no; the managed block is written by an administrator** — buys: no new reads of personal data,
  no new writer of a permission-granting file, and the safety story stays "a human wrote these rules". —
  costs: users who want auto mode hand-write allow entries or, more likely, reach for a broad rule —
  which is the failure this feature exists to prevent.
- **B — yes, from project sources only (CLAUDE.md, README, git remotes, the repo's own scripts)** —
  buys: most of the drafting value from data the agent already reads in the ordinary course of work; the
  proposal is reviewable line by line before anything is written. — costs: a new writer of permission
  rules, which needs a managed-policy off switch and an audit line; and the draft's quality is the
  weakest part — a bad suggestion accepted is a broad allow rule with a friendly provenance.
- **C — B plus the optional personal sources (shell history, home-directory repositories)** — buys: the
  documented feature in full, and materially better drafts. — costs: the agent reads shell history — a
  category of personal data we read nowhere today; on a corporate deployment this is a policy question
  before it is a product one.

**Recommendation:** **B**, with the writer gated behind an explicit per-entry confirmation and a managed
off switch, and **C declined** until an operator asks for it in writing.

**Parity direction.** All three options are uniform across runtimes by construction (the host would own
the drafting and write our config, not `~/.claude/settings.json`), so **B and C close the difference with
the page; A declares it**. The claude-native command stays unreachable either way — worth one sentence in
the switch report.

**Evidence:** `auto-mode-config.md:179` names the project sources it reads; `git grep -aEin
'auto-mode-setup|autoModeSetup' -- packages apps` → 0 (the identifier appears only in
`scripts/claude-doc-anchors.tsv`); `grep -ac auto-mode-setup <vendored binary>` → 23 as the control that
the command exists natively.

### [host] A per-session scratch directory whose writes never raise a permission prompt

*(denominator slice A#1)*

**Closes:** Denominator A81 — `absent` on all three.

`agent-view.md:704` documents a per-session scratch root with the load-bearing clause *"Writes here don't
prompt for permission"*, with `CLAUDE_JOB_DIR` as its companion at `:706`. The SDK **reads the variable**
— it is in the shipped bundle — so on claude this is configuration, not construction. Codex has no
equivalent in `packages/codex-protocol`; Pi's harness has no no-prompt scratch root either. Today a
session's temp files are gated one prompt at a time, and parallel sessions can collide on the same paths.

- **A — no; every write stays gated** — buys: exactly one rule — every write the model makes is seen by
  the gate — with no carve-out to reason about and no path an exfiltration could aim at without a
  prompt. — costs: a prompt per temp file, which trains users to allow broadly; and parallel sessions
  keep colliding on shared temp paths, which is a real defect and not only an annoyance.
- **B — yes; one host-owned directory per session, named in the gate** — buys: the collision goes away,
  the prompt noise goes away, and the exemption is a single host-owned path the gate itself names, so it
  is auditable and reportable; on claude it is the runtime's own mechanism (`CLAUDE_JOB_DIR`) rather
  than a host invention, which is native-first tier 1. — costs: a directory the model may write without
  ever being asked — it must be per session, outside the workspace, excluded from any read that feeds
  the model's context, and torn down with the session, or it becomes a staging area.

**Recommendation:** **B**, with the teardown and the "never re-read into context" property pinned by a
test, and one switch-report line saying codex and Pi get a host-supplied equivalent rather than a native
one.

**Parity direction.** **B closes the difference** and does it uniformly (host-owned path on all three,
using claude's own variable where it exists). **A leaves it absent everywhere**, which is at least
uniform — this is one of the few cells where the status quo is already honest.

**Evidence:** page `https://code.claude.com/docs/en/agent-view.md#where-state-is-stored`, table row at
`:704` ("Writes here don't prompt for permission"), companion `CLAUDE_JOB_DIR` at `:706`;
`CLAUDE_JOB_DIR` scores 0 files across `packages` + `apps` (2 repo-wide, both in
`docs/superpowers/specs`) while it IS in the shipped bundle — 2 hits across
`node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs` and `sdk.mjs`, positive control
`disableAllHooks` 2 on the same run.

### [host] Does the Windows build owe a WSL2 agent mode?

*(denominator slice A#1)*

**Closes:** Denominator A87 — `absent` on all three.

On Windows the choice between running the agent natively and running it inside WSL2 decides **which
sandbox implementation protects the machine**: codex's own documentation says Windows-native uses the
Windows sandbox while WSL2 uses bwrap+seccomp. The selector is the ChatGPT desktop app's own UI, not a
config key — but the consequence is codex's. Our Windows path is committed to the native sandbox
(`[windows] sandbox = "unelevated"`), and Pi and claude have no WSL twin at all. The parked spike P3.7
("can our win32 build drive a codex/pi runtime inside WSL2") is EVIDENCE for this question, not an
answer to it, and it is blocked for want of a Windows host on any rig.

- **A — no; Windows-native only, stated beside the `unelevated` decision** — buys: one Windows sandbox
  story to maintain, test and report; no path mapping, fd-limit or bubblewrap-floor work; the decision
  is written where the next reader meets it. — costs: on Windows we ship the weaker of the two sandbox
  implementations codex supports, and a user who already works in WSL2 gets an agent that does not live
  where their code does.
- **B — a per-workspace selector, after P3.7 reports** — buys: the stronger sandbox for users who want
  it, and the agent runs where the workspace actually is. — costs: a second Windows runtime topology to
  build, test and support (path mapping, fd limits, the bubblewrap floor), on a platform with no rig
  today; and the sandbox implementation would then differ per workspace, which every switch-safety
  surface would have to learn.

**Recommendation:** **A**, until a deployment asks for B in writing. Unpark P3.7 only when a Windows rig
exists — until then B cannot be costed, and a decision taken without it would be invented.

**Parity direction.** **B closes the difference** with what codex's own host offers; **A declares it**
beside the `unelevated` decision. Neither changes a Pi/claude difference — they have no WSL concept.

**Evidence:** no WSL agent-mode selector found — `apps/electron/scripts/build-win.ps1` has no WSL branch
and the codex spawn is a direct child (`packages/codex-agent-server/src/runtime-manager.ts`); the Windows
sandbox we DO configure is the native one, `packages/server-core/src/pi-harness/isolation/windows.ts:118-120`
writes `[windows] sandbox = "unelevated"`; page `agent-approvals-security.md` §OS-level sandbox (weak
tier); plan `P3.7` (⬜, PARKED, plan line 3176 — "no Windows host on any rig; WIN-1 in the CDP table
waits for one"), spike defined at plan `:1973-1975`.

### [host] Deploy a fixed MCP server set users cannot add to — or restate the 2026-07-29 ruling that we will not

*(denominator slice B#0)*

Closes: **B12** (`managed-mcp` — deploy a fixed set of MCP servers users cannot add to, modify or bypass,
including disabling MCP entirely with an empty server map). Verdicts absent ×3, klass OWNER, size L.

already_ruled: `docs/superpowers/specs/2026-07-29-deviation-audit.md:193` puts `managed-mcp.json` delivery
out of scope ("Record as C"). The ruling has never been restated in the out-of-scope register, so the
capability keeps being re-found as a gap — this question asks whether to confirm it or reopen it.

What exists at HEAD: `managed-mcp.json` → **0** tracked files (controls on the same rig: `allowedChannelServers`
→ 6, `strictPluginOnlyCustomization` → 13). Our gate `isManagedMcpServerAllowed` (imported `storage-runtime.ts:22`,
called `:1085`, `:1179`, `:1209`, `:1224`) can FILTER what a user configured; it cannot DEPLOY a server, and
there is no empty-map "MCP off" pole. Native-first: claude reads `managed-mcp.json` itself from the three
documented system paths, so a projected file would be honoured natively by that runtime alone; Pi and codex
would need the host to supply the set.

- **Confirm the ruling and restate it in the out-of-scope register** — buys: no second config format enters the tree for a fleet that does not deploy one; the absence stops being re-found by every sweep; zero code. — costs: an organisation can never say *these servers and no others*, only *not those*; the empty-map "turn MCP off entirely" pole stays unreachable; claude keeps a native mechanism we deliberately do not feed.
- **Project `managed-mcp.json` for claude only** — buys: the one runtime that reads it natively gets the full documented capability for a small, well-bounded write. — costs: a NEW silent divergence of exactly the class this ledger exists to catch — the same policy deploys servers on claude and does nothing on Pi or codex — unless a switch cost is written in the same commit.
- **Host-side deployed server set for all three** — buys: the capability lands uniformly, one seam, and the empty-map pole becomes expressible on every runtime. — costs: L; a second config format and its precedence against the user's own MCP config, the approval surface, and the credential story for a deployed server.

Recommendation: **confirm the ruling and restate it in the register**, per the source slice's own
recommendation — the alternative imports a second config format for a fleet that does not deploy it.
Parity direction: option 3 is the only one that closes the difference; option 2 widens it.

---

### [host] Should a managed plugin mandate ACQUIRE the plugin, or stay the report-only no-op it is today?

*(denominator slice B#0)*

Closes: **B13** (`51 discover-plugins` — have an administrator's plugin actually installed by policy, the
"managed" install scope). Verdicts absent ×3, klass OWNER, size L.

What exists at HEAD, asked and answered in-tree: managed `enabledPlugins` is read by the ACTIVATION overlay
only; nothing installs. `packages/shared/src/plugins/mandated-plugins.ts:9-19` states it verbatim — "Nothing
installs it… The mandate is a silent no-op". It is not fully silent: `config-doctor.ts:54-55,165,416,604-605`
renders a "Force-enabled plugins:" section and `:640` folds `hasUnfulfilledPluginMandate` into the doctor's
verdict, wired from `apps/cli/src/doctor.ts:36-51`. The runtime that COULD install (claude) is fed
`plugins: []`. Page `51 discover-plugins` line 302. Scope: an organisation control that silently stops
controlling — the administrator states the plugin runs on the fleet and it does not.

- **Report-only, as today** — buys: nothing is acquired or executed from policy; the no-op already surfaces in the doctor, so the honesty surface exists; zero code. — costs: the documented "managed" install scope is simply absent; an administrator's mandate is advisory on every runtime, and the report reaches only the CLI doctor, which the desktop app has no route to.
- **Acquire at boot from a delivered marketplace** — buys: the mandate does what the page says; an organisation can guarantee a plugin is present, not merely enabled where already installed. — costs: unattended execution from policy — the host fetches and installs code because a file said so, at boot, before any user is present; it needs the delivered-marketplace trust story, a failure posture when the fetch fails, and it makes the managed tier a code-delivery channel.

Recommendation: **(a) report-only**, per the source slice — (b) is unattended execution from policy.
Parity direction: neither option creates a runtime difference (the mandate is host-side and uniform);
option (a)'s residue is a BUILDABLE S — carry the doctor's "Force-enabled plugins" verdict onto a
desktop-reachable surface, since today the only reach is CLI-only.

---

### [host] Does the built-in browser owe an administrator a graduated policy, or stay the all-or-nothing switch?

*(denominator slice B#0)*

Closes: **B16** (`desktop (#22)` + `row 18 · browser` — let an administrator express which origins the pane
may reach, whether the agent's tools act on external pages, and whether upload and download are allowed).
Verdicts partial ×3, klass OWNER, size L.

Two reader premises were measured WRONG and are corrected here before the options: (1) a tools-off tier
ALREADY EXISTS host-side for all three — `getBrowserToolEnabled()` (`config/storage.ts:1338`, default true at
`:131`/`:270`) gates `browser_tool` out of the session tool defs (`agent/session-scoped-tools.ts:345-348`,
`agent/pi-agent.ts:2555`), surfaced at `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx` symbol `handleBrowserToolEnabledChange` (re-anchored by symbol 2026-10-16 (UB15.5): the page moved onto the SettingsPage column and its line anchor went stale); (2) "the managed-settings surface carries no
browser keys" is FALSE — `packages/shared/src/agent/claude-managed-settings.ts` symbol `disableInAppBrowser` defines it as a
`host-gate` key whose enforced composition feeds the pane gate and whose startup pass CLOSES an already-open
pane (P3.257(b), measured 2026-09-03), with the headless host covered by `NullBrowserPaneManager`. So this
extends a live mechanism rather than adding one. What is genuinely absent is GRANULARITY: no origin allowlist,
upload gate or download gate in `browser-pane-manager.ts` (the shared partition and annotation caps around
`:1113-1157` carry no policy layer), and no admin key feeding the existing tools-off gate.
`config/managed-in-app-browser.ts:26-40` already weighed three postures and rejected an allowlist "because
there is nothing to read it from". Codex publishes its own `[features] in_app_browser` boolean with no consumer
in the binary. Verdicts moved absent → partial on both slices.

- **Keep the binary switch; state the codex asymmetry** — buys: nothing new to maintain; the existing `disableInAppBrowser` key is real and enforced. — costs: an administrator can only take the browser away wholesale; the graduated policy an organisation would actually write cannot be expressed; codex's consumer-less `in_app_browser` boolean stays a key that reads as a control and is none.
- **Add an admin key feeding the existing tools-off gate** — buys: the smallest honest step — an administrator can leave the pane for the human and take it from the agent, reusing a gate that already works on all three; S–M, not L. — costs: still no origin concept, so "the agent may browse our intranet and nothing else" remains unsayable.
- **Origin allow/deny for the pane** — buys: the tier an organisation behind corporate egress controls actually asks for; a real answer to "which origins may this agent reach". — costs: an origin concept the pane does not have today, and a policy layer in `browser-pane-manager.ts`; every redirect, iframe and download URL needs a rule.
- **Origins plus upload and download gates** — buys: the full documented posture — egress, ingress and exfiltration each separately expressible. — costs: L, and the upload/download half touches the file-transfer path as well as the pane.

Recommendation: **(c) origin allow/deny**, per the `row 18 · browser` slice; the `desktop (#22)` slice's own
recommendation, **(b) an admin key on the existing tools-off gate**, is the cheaper first step and is
strictly contained by (c) — take (b) now and (c) next if the origin concept is wanted.
Parity direction: (b) and (c) are host-side and close the difference on all three at once; the residual
codex asymmetry (its own consumer-less `in_app_browser`) must be named in the switch report either way.

---

### [host] Reopen R50's delivery channels — MDM plist and HKLM — or document file-plus-drop-in as the only channel?

*(denominator slice B#0)*

Closes: **B17** (`admin-setup`, `managed-settings` — deliver managed policy through OS policy channels that
resist tampering). Verdicts absent ×3, klass OWNER, size L.

already_ruled, VERBATIM: `docs/superpowers/plans/2026-08-04-doc-sweep-parity-wave.md:2853` — R50
`managed-policy-sources`, "DROPPED, owner decision 2026-08-08", "there are no third-party administrators".
Also `docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:480` — "only 2 of the 4 documented
delivery mechanisms exist". This question exists only because the ruling predates the ledger and the sweep
keeps re-finding the capability; answering it once closes B17 permanently either way.

Verified at HEAD `34be43fde`: our managed tier is file + server only, at Nessy paths
(`/Library/Application Support/Nessy`, `C:\ProgramData\Nessy`) — `pi-harness/isolation.ts:118` and
`isolation/self-config-deny.ts:105-112` (`managed-policy.json` + `managed-policy.d/`),
`managed-composition.ts:402-428` composing exactly two sources into winner `delivered`/`file`/`none`;
`managed-system-paths.ts:110-120` names the `HKLM\SOFTWARE\Policies` route as the native-first candidate NOT
taken. Probes: `com.anthropic.claudecode` 0, `plutil` 0, `managedPreferences` 0, `winreg` 0; control `MDM`
→ 17, all doc-comments. Native mechanisms that exist and we do not use: the vendored SDK reads MDM/HKLM/HKCU
itself for the child it spawns; codex has an MDM `requirements.toml` entry upstream that this host never
writes or reads; Pi has none — the host is its only policy reader. Distinct from B10, which is our OWN file
tier being inert on win32.

- **Confirm R50: document file + drop-in as the only channel** — buys: the ruling is restated where sweeps read it, the absence stops being re-found, zero code. — costs: our policy file is user-writable in a way an OS policy channel is not, so a determined user on their own machine can defeat the managed tier; three of four documented channels stay absent.
- **Add a macOS configuration-profile reader** — buys: a tamper-resistant channel on the platform this product is developed and demoed on; aligns with what the vendored SDK already reads for its own child. — costs: a plist reader plus its precedence against the two existing sources; an MDM to test against, which no rig has.
- **Add an HKLM policy reader on Windows** — buys: the channel a Windows fleet actually uses, and it is already named in-tree as the untaken candidate. — costs: needs the Windows evidence day that P3.7 parks for want of a Windows host; couples to B10, which must land first or the reader has nothing to enforce.

Recommendation: **(a) confirm R50 and document the two channels**, then **(c) HKLM** if a Windows fleet ever
becomes real — that is the source slice's own order.
Parity direction: (b) and (c) each close the difference on ONE platform only; option (a) closes nothing and
makes the limit honest, which is the correct trade while "there are no third-party administrators" holds.

---

### [host] May an operator forbid personal-key and BYO authentication and require the gateway sign-in?

*(denominator slice C#0)*

*(closes denominator **C10** — `admin-setup`; Pi `absent`, claude `absent`, codex `absent`)*

The vendor ships `forceLoginMethod` / `forceLoginOrgUUID` and the SDK managed tier that would carry
them is live at HEAD (`packages/shared/src/agent/claude-agent.ts` symbol `ClaudeAgent` calls
`buildClaudeManagedSettingsOptions`, so out-of-scope O8's *"no production caller"* is STALE). We carry
neither: `git grep -ail -F forceLoginMethod` over `:(glob)packages/**` `:(glob)apps/**` → 0 files;
`forceLoginOrgUUID` → 2 files, both non-production
(`packages/shared/src/agent/claude-managed-settings.ts` symbol `forceLoginOrgUUID` prose and
`managed-policy.test.ts:381-384`, which pins it as a key-we-do-not-carry producing a named DROP).
Bundle probe `forceLoginMethod` → 2 (controls `Cookie` 5, `git-subdir` 4). Pi and codex have no native
login-method gate; the host owns credential selection for all three.

- **A. Host-side enforcement — a managed key that hides and refuses every non-gateway connection card** — buys: real enforcement on all three runtimes from one seam, which is what the corporate deployment the page is written for actually asks for; the refusal is legible at the card, not at turn time — costs: removes the BYO escape hatch an operator today relies on for an outage or a model the gateway does not serve, and every support path that starts *"paste your own key"* stops working.
- **B. Disclosure only — one operator-visible line naming the policy, no refusal** — buys: nothing breaks, the divergence becomes honest, and it is the smallest thing that can ship this quarter — costs: it is not a control, so an organisation that believes it has forbidden personal keys has not; a control that does not control is the defect class this fork is closing.
- **C. Project the vendor's own `forceLoginMethod` to the claude child and stop there** — buys: native-first step 1, configuration rather than construction, and the vendor enforces it inside its own binary — costs: it enforces on ONE of three runtimes; a user switches to Pi or codex and the policy silently evaporates, which manufactures exactly the silent divergence the host exists to prevent.

Recommendation: **A**, with B's line as its refusal text. C only as a belt on top of A, never alone.

Parity direction: **A closes the difference on all three runtimes.** B keeps the difference and makes
it honest. **C closes it on claude only and opens a new one.**

### [host] Should Nessy Desktop offer projects on remote SSH hosts at all?

*(denominator slice C#0)*

*(closes denominator **C17** — `remote-connections`; Pi `absent`, claude `absent`, codex `absent`)*

Codex publishes an SSH story, evidence **WEAK — page only, intent not behaviour**:
`learn.chatgpt.com/docs/remote-connections.md#connect-to-an-ssh-host` reads aliases from `~/.ssh/config` and starts `codex`
on the remote PATH, and `#hand-off-a-chat-between-hosts` covers the handoff. Not found in
`github.com/openai/codex` at `rust-v0.148.0`; the shipped binary was not probed; no handoff field
exists in `packages/codex-protocol/generated/v2`. Our side is local-only by construction: `ssh`
(case-insensitive) in `packages/codex-agent-server/src/` = 0 files against the positive control
`stdio` = 9 files, and `app-server-client.ts:1-2` describes itself as *"Minimal JSON-RPC 2.0 client
over the codex app-server's newline-delimited stdio transport"*. The same-host handoff machinery we DO
have is `packages/server-core/src/sessions/runtime-handoff.ts` (`packages/server-core/src/sessions/SessionManager.ts` symbol `buildRuntimeHandoffPayload`) —
**not** `base-agent.ts:422`, which only names it in a comment.

- **A. Stay local-only and record the divergence (~5 lines)** — buys: honest today, costs nothing, and does not build a product surface on a page-only claim we have not been able to confirm in codex's own source — costs: a real capability of one runtime stays unavailable on all three, and the disclosure will read as an excuse to anyone who has used it in codex's own CLI.
- **B. Build SSH projects on our own websocket server, uniformly for all three runtimes** — buys: remote work on every runtime rather than one, through the transport we already own and can audit; the handoff reuses `runtime-handoff.ts` — costs: a plan, not a lane — a remote filesystem, a remote shell, credential handling on the far side, and every permission floor in this product re-derived for a machine the user is not sitting at.

Recommendation: **A** — and, before B is ever costed, probe the shipped codex binary so the option is
built on measured behaviour rather than a Beta-marked page.

Parity direction: **B closes the difference on all three runtimes at once** (the host seam, native-first
step 2). A keeps it and makes it HONEST, which is the host's job when step 1 and step 2 both cost more
than the capability is worth today.

### [host] Reopening a long, stale conversation: load it as-is, always compact, or ask once and remember

*(denominator slice E#0)*

Closes **Denominator E8** (`absent` on pi, claude and codex alike — it is a host dialog over our own
transcript, not a runtime capability). The compaction it would invoke already exists on all three
(E10, `contextUsage.compact.manual`), so this decision is only about the TRIGGER and the DEFAULT.
Upstream gates the prompt on a Pro/Max plan plus inactivity and conversation size; we have no such
plan, so the staleness/size trigger is ours to choose as well as the default.

- **A — always load as-is** — buys: faithful, nothing is ever silently dropped, no new dialog, no new setting. — costs: the whole history is re-sent on every later request, at a per-request cost that scales with the conversation's size; the user pays it without ever being offered the alternative.
- **B — always compact on reopen** — buys: cheapest reopen, one code path, no dialog. — costs: lossy, and the user is never told what was dropped; a reopen becomes destructive, and there is no way back to the full transcript.
- **C — ask once and remember the answer, as the page does** — buys: the only option whose divergence is VISIBLE at the moment the cost is incurred; the answer is remembered, so it is one dialog per conversation, not per reopen. — costs: one extra dialog; the operator must pick the staleness/size trigger we do not inherit from a plan tier, and that trigger becomes a setting we own.

Recommendation: **C**. A and B both make a cost decision silently on the user's behalf, and this is a
user-visible policy with a real per-request bill attached. **Parity direction:** C closes the
difference — E8 is `absent` on all three runtimes, so any option makes the three uniform, but only C
makes the host's residual choice (the trigger) honest instead of hidden; A and B leave the product
diverging from the documented upstream behaviour with nothing on screen to say so.

### [host] Deleting all local state for a project — ours only, ours and the runtime's, or neither

*(denominator slice F#0)*

Closes **Denominator F17** (`absent` on pi, claude and codex alike — the session store, the task store
and the debug logs are all ours, so no runtime offers a purge a host could call). The per-SESSION delete
already exists (`apps/cli/src/index.ts` symbol `cmdSessionDelete`, the positive control); what has no symbol anywhere is a
project-scoped one — `purgeProject` and `deleteWorkspaceData` score 0 hits over `packages/shared/src`,
`packages/server-core/src` and `apps/electron/src`, the only `purge*` symbols being plugin- and
capability-scoped (`capabilities/policy-store.ts:241`, `trust-store.ts:164`,
`plugins/mcp-credentials.ts:91`). The complication is that codex writes its own `~/.codex` history, so
any purge must name it or exclude it — silence is the one answer that cannot be defended.
Page `cli-reference.md`.

- **A — purge our own state and SAY codex's `~/.codex` history is untouched** — buys: one uniform command across all three runtimes, deleting exactly what this product wrote — transcripts, task lists, debug logs, file-edit history, prompt history and the config entry — with the residue named on screen so the user knows where to look next. — costs: the user must delete a sibling tool's data themselves; the command is honest but not complete.
- **B — purge ours and the runtime's, including `~/.codex`** — buys: one gesture really does leave nothing behind, which is what a user asking to delete a project means. — costs: we delete data written by a tool the user may also drive outside Nessy, from a command whose name says "project"; irreversible, cross-application, and the blast radius is not ours to bound. Our own codex containment argues against it — `CODEX_HOME` is `mkdtempSync`ed and `rmSync`ed per session, so the durable `~/.codex` we would be deleting is by definition the user's OTHER codex, not ours.
- **C — no purge; keep per-session delete and document the divergence** — buys: nothing new to get wrong, no destructive command to mis-aim. — costs: the documented capability stays absent on all three, and a user offboarding a project has no supported route at all; the gap stays invisible.

Recommendation: **A**. Deleting a sibling tool's data silently is not a posture to take, and B is the
only option that does it. **Parity direction:** the cell is `absent` on all three, so A and B both make
the three uniform — A does it while keeping the residue HONEST, which is the standing host rule; C
leaves the difference from the documented product in place with nothing on screen to say so.

### [host] Never persisting a transcript at all, or leaving the retention cap as the whole answer

*(denominator slice F#0)*

Closes **Denominator F18** (`partial` on pi, claude and codex — verdicts corrected: the reader's "no
user-facing off switch or cap" is half REFUTED, because the cap ships and sweeps; and the codex cell
moves `n/a` → `partial` because the transcript this capability would turn off is the HOST's, written
identically on the codex arm — only codex's OWN `[history]` file is `n/a`, since our `CODEX_HOME` dies
with the session by the Dev-11 ruling). So the question is narrower than it looks: a user-settable,
admin-pinnable retention CAP already exists and sweeps transcripts; what has no equivalent is the
**never-persist** direction. The machine for it exists too — the ephemeral session flag gates every
persist call (see the F9/F10 row) — so this is a posture decision, not a build estimate.
Page `config-advanced (row 29)`; codex's own key is `history` / `history.max_bytes`
(`codex-rs/config/src/config_toml.rs:320`, strong tier), and `git grep -a '\[history\]' -- packages apps` → 0.

- **A — offer a never-persist mode as a first-class setting** — buys: the documented capability, reachable by a user who does not want finished sessions on disk at all; it rides the ephemeral machine that already exists, so it is small. — costs: a session that persists nothing cannot be resumed, rewound or searched, and the user meets that only after the fact unless the mode says so up front; every recovery feature in this group silently becomes absent inside it.
- **B — leave the retention cap as the whole answer, and say so** — buys: no new mode, no new failure surface; the cap is already user-settable and admin-pinnable and already deletes transcripts, checkpoints, plans and the vendor's own tree. — costs: the minimum retention is not zero (`setRetentionDays` rejects 0), so "never on disk" stays unreachable; a user with that requirement has no answer and the divergence stays unwritten.
- **C — allow the cap to reach zero, so the sweep deletes on close** — buys: one mechanism, one setting, no new mode; the shortest path from what ships today to what the page describes. — costs: it is a false never-persist — the transcript IS written and then deleted, so it exists on disk for the life of the session, which is exactly the property a user asking for this is trying to avoid; and it would be indistinguishable, in the setting's own words, from A.

Recommendation: **A**, with the mode stating its cost when it is entered. **Parity direction:** F18 is
`partial` on all three because the cap is host-side and uniform, so any option keeps the three uniform;
A is the only one that closes the difference from the documented capability, and C closes it in name
while leaving the disk write in place, which is the shape this fork's largest defect class already has.

### [host] Waiting out a usage limit: wait where a reset is published, retry on a fixed interval, or surface it and stop

*(denominator slice F#0)*

Closes **Denominator F21** (`absent` on pi, claude and codex — no arm waits, on any runtime;
`autoContinueAtUsageLimit` → 0 files). The measurement that shapes the options: **a reset timestamp
EXISTS on two of the three arms and neither drives a wait.** Claude's `rate_limit_event` carries
`resetsAt` and we already normalize and print it (`backend/claude/event-adapter.ts:524`, `:1974-1984`
→ *" Resets <date>."*). Codex's `RateLimitWindow.resetsAt` exists but arrives on
`account/rateLimits/updated`, which sits on the deliberate unread list
(`codex-notification-families.ts:205`). The Nessy gateway is not verified to publish one at all.
Page `interactive-mode.md`.

- **A — wait only where a reset timestamp is published, and say so where it is not** — buys: the session resumes by itself at a time the SERVER named, so the wait is bounded by a fact rather than a guess; on the gateway arm the user is told plainly that no reset was published and the turn stops. — costs: behaviour differs by connection, which must be stated at the switch; and the codex arm needs `account/rateLimits/updated` taken off the unread list, which is a small scope increase with its own verdict.
- **B — fixed-interval retry everywhere** — buys: one code path, uniform on all three, no dependency on a field the server may not send. — costs: it invents a reset the server never promised — the retry either fires too early and burns the limit again, or too late and wastes the user's time; and on the two arms where a real timestamp EXISTS it deliberately ignores it.
- **C — leave it, and surface the limit honestly** — buys: nothing new to get wrong; the limit and its reset time are already printed on the claude arm. — costs: an unattended session dies at the limit and the work is lost, which is the failure this capability exists to prevent; the gap stays absent on all three.

Recommendation: **A**. B invents a reset the server never promised, which is the failure mode the
read-don't-invent rule is written for. **Parity direction:** A leaves a REPORTED divergence (the
gateway arm waits for nothing and says so) rather than a silent one, which is the honest-seam rule; B
is uniform and wrong; C closes nothing.

### [host] A runtime-blind multi-session screen — build it, or keep the divergence

*(denominator slice F#0)*

Closes **Denominator F27** (`absent` on pi, claude and codex). **Read this before answering: the
standing ruling everyone reaches for is NOT about this cell.** P4.7 and DR-1 (plan `:3550` and `:1147`)
rule on the Pi runtime inspector over `getPiHarnessRuntime` — *"DO NOT BUILD … a panel absent on two
runtimes of three reads to a user as claude is worse"* — a **Pi-only** surface. A runtime-blind
multi-session screen over the host's own session records is a different proposition and is **unruled**.
The page-level divergence is already recorded
(`docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:461`, row 52: *"`claude agents`, the
per-user supervisor … have no counterpart in this fork"*). Native mechanism, asked: claude's supervisor
and `claude agents` are in the shipped bundle (`CLAUDE_JOB_DIR` and `bgIsolation` both probe 2 hits) but
are a **CLI-process** feature, not an SDK surface a host can drive; codex has none; Pi's is the runtime
snapshot, Pi-only by construction. So there is no native mechanism on any of the three, and the only
seam is the host's own session records — which every runtime writes identically.
Page `agent-view.md`.

- **A — no screen; keep the divergence and record it** — buys: no new surface to keep honest, no Phase-4 design cycle, and the recorded page-level divergence stands as the answer. — costs: unattended work stays silently blocked — a session waiting on a permission request is invisible until someone opens it — and every downstream capability in this group (row summaries, background jobs, peek-and-reply at scale) has nowhere to live.
- **B — build it host-side, runtime-blind, over the session records** — buys: dispatch and manage many sessions from one screen with what each is doing, which need input, which finished or failed, plus peek, attach, stop, pin, rename and reorder — identical on all three runtimes by construction, because the data is ours; it is the ONE surface in this group that cannot manufacture a Pi-only divergence. — costs: an L build with its own i18n, playground states and Phase-4 design pass; and it must refuse to render any per-runtime field, or it becomes the thing P4.7 declined.

Recommendation: **B**. The reason P4.7 declined its panel — that a Pi-only surface manufactures the
divergence this wave exists to close — argues FOR this one, because a screen over host records is
uniform by construction. **Parity direction:** the cell is `absent` on all three, so both options keep
the three uniform; only B closes the difference from the documented product, and it is a precondition
for the smallest honest piece already queued as a row (peek-and-reply over the session list).

### [host] One-line session summaries — derive them free, or spend a model turn

*(denominator slice F#0)*

Closes **Denominator F29** (`partial` on pi, claude and codex — auto-TITLING already exists and is
shared, `sessionTitle`/`generateTitle`/`autoTitle` resolving in 28 files across `packages` + `apps`
with a test behind it; what does not exist is a per-turn status summariser or any mini-model routing
for one). **Reclassified from BUILDABLE by the sweep, and the reason is the whole question: a per-turn
model request on the user's quota is an operator cost, not an implementation detail.** Native
mechanism, asked: claude's SDK does this for its OWN agent view and that view is unreachable from a
hosted session; codex has none; Pi has none; the host's nearest asset is the mini-model concept
(`packages/pi-agent-server/src/pick-mini-model.ts`), which is where either answer would attach. **The
page's own fallback rule is exactly our situation and has no reader:** `agent-view.md:146` — *"On a
third-party provider or gateway with no Haiku-class model configured, the request uses the session's
main model instead"* — so on the Nessy gateway the documented behaviour is to bill the MAIN model for
every row summary. Page `https://code.claude.com/docs/en/agent-view.md#row-summaries`.

- **A — derive the row from the session's own output, with no extra model call** — buys: free, instant, no quota consumed, no new model routing, and it works identically on all three runtimes; the row is always in step with what the session actually last said. — costs: the line is a truncation or a heuristic rather than a summary, so it will read worse than the documented feature on long or tool-heavy turns.
- **B — spend the connection's mini model on each row** — buys: the documented capability, a real one-line summary of what the session is doing. — costs: a recurring per-turn charge on the user's quota that they did not ask for and cannot see, and on the gateway — our default connection — the page's own fallback says it lands on the MAIN model, which is the expensive one; it also needs the mini-model routing this product does not have for this purpose.

Recommendation: **A** for now. It is free, uniform and honest, and it leaves B reachable as a setting
later if the summaries prove worth paying for. **Parity direction:** the cell is `partial` on all three
and both options keep it uniform; A closes the visible gap at zero operator cost, B closes it fully at
a cost the user cannot see — and an invisible recurring charge is the posture this product has
elsewhere refused.

### [host] Background auto-commit before an unattended session finishes

*(denominator slice F#0 · pointer)*

→ sitting §1.7

(Closes **Denominator F30**, `absent` on pi, claude and codex. Two things this slice ADDS to the
sitting entry rather than restating it: `agent-view.md:501` is a SECOND published place for the
preserve-before-finish clause, which strengthens option (B) there; and ledger **I4** is the adjacent
row to close in the same pass — I4 reads `absent ʰ / absent ˢ / absent ˢ`, DEFECT, *"our cleanup is
age-based and removes without snapshotting. Data-loss-adjacent"* — the same data-loss risk from the
HOST side, where §1.7 decides the MODEL side. Plan scope: DR-2, plan `:1145`.)

### [host] A user-typed background shell job, outside any session

*(denominator slice F#0)*

Closes **Denominator F31** (`absent` on pi, claude and codex). Native mechanism, asked and answered:
**none on any of the three** — this is a host job runner, not a runtime feature; codex and the claude
SDK both expose shell execution only as an agent TOOL CALL, which is the opposite of what the page
describes (a row you watch and attach to, with no model in the loop). The machinery exists on one
runtime only and is not general: `packages/core/src/types/pi-harness-runtime.ts:28` types a process row
(`'running'`, `'exited'`, `'stopped'`, `'timed-out'`, `'lost'`) fed by the Pi process supervisor. The
CLI has no such flag either — `--bg` scores FIVE files across `packages` + `apps` (re-measured
2026-09-10, W9-cj: 6 lines over 5 files) and every hit is a COMMENT quoting the claude SDK's own
agent-view sentence: `apps/cli/src/index.ts` symbol `parseArgs`, plus
`packages/server-core/src/pi-harness/child-session-service.ts` symbol `disableAgentView`
and its test, `packages/shared/src/agent/pi-harness/managed-policy.ts` symbol `disableAgentView`, and
`packages/pi-agent-server/src/orchestrator/spawner-agent-view-disabled.test.ts`. `claude --exec` has
no host caller. The page-level absence is already
recorded at `docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:461`.
Page `https://code.claude.com/docs/en/agent-view.md#run-a-shell-command`.

- **A — no; commands stay gated tool calls** — buys: every shell execution in this product keeps passing the permission gate, the breakers and the audit path, with exactly one route in and one place to reason about it. — costs: the documented capability stays absent on all three, and a user who wants to watch a build beside their session has no route but a terminal outside the app.
- **B — yes, host-side over the Pi supervisor rows** — buys: the documented row-you-can-watch, reusing a supervisor that already tracks state, output and termination. — costs: **it is a shell-execution path the permission gate does not see** — the gate is built for tool calls, and a user-typed job arrives beside it; the supervisor is Pi-shaped, so making it runtime-blind is part of the build; and it overlaps J9 (an interactive terminal in the chat), which would then be the second uncovered execution route.

Recommendation: **A**, unless J9 is taken — if an interactive terminal is built, the gate question is
answered there and B becomes a small addition to it rather than a new hole. **Parity direction:** the
cell is `absent` on all three and stays uniform either way; A leaves a documented gap with a recorded
reason, B closes it at the cost of a second execution route the safety floor was not designed for, and
that trade is the owner's, not a lane's.

### [host] Prompt history across sessions — reverse a recorded privacy choice, or document the divergence

*(denominator slice F#0)*

Closes **Denominator F36** (`absent` on pi, claude and codex — host-side and runtime-independent).
**The measurement is already done and recorded, so this is only a posture:** there is no cross-session
prompt history at all; the composer's history is an in-memory ref whose only writer is the double-Esc
clear, and it is dropped on every session switch **by design, with the reason written at the site**.
`apps/electron/src/renderer/components/app-shell/input/double-escape.ts:59-71` — verbatim: *"`promptHistory`,
`inputHistory`, `recentPrompts` and an `ArrowUp` recall in the composer all measured ZERO before this
row (positive control: `ArrowUp` itself is present) … Submitted prompts are NOT recorded, it is
in-memory … dropped on a session switch"*; the drop and its leak reason are at
`apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` symbol `FreeFormInput`. So persisting prompts per directory **reverses a recorded privacy
choice**, which is why this is not a lane's call. Page `interactive-mode.md`.

- **A — keep it in-memory and per session** — buys: today's behaviour, the recorded privacy choice intact, nothing new on disk. — costs: the documented capability stays absent, and the absence is undocumented too — a user pressing ArrowUp after a session switch simply gets nothing, with no explanation.
- **B — persist prompts per directory, honouring `NESSY_SKIP_PROMPT_HISTORY`** — buys: the documented capability, including search by scope, on all three runtimes at once. — costs: it writes what the user typed to disk, per project, reversing a choice this repo made deliberately; and it inherits the F9 defect until that row lands, because the opt-out env spelling currently does nothing in the desktop — so B shipped first would be a persistence with a **broken off switch**.
- **C — document the divergence, and leave the behaviour** — buys: the honest surface at near-zero cost; the absence stops reading as a bug. — costs: still absent; a user who wants the feature is told no, in writing.

Recommendation: **C first, then B** — say what the product does now, and if prompt history is wanted,
land it only AFTER the F9 row makes `NESSY_SKIP_PROMPT_HISTORY` real, so the opt-out exists before the
data does. **Parity direction:** `absent` on all three and uniform under every option; C makes the
difference from the documented product HONEST, B closes it — and B without F9 would close it while
silently removing the user's only way out, which is worse than the gap.

### [host] How does a user's own environment reach a host-run command hook?

*(denominator slice G#0)*

Closes: **denominator G15** (pi `absent`, claude `partial`, codex `absent`) — "Turn one review
layer off, or choose the review model, with the security plugin's own environment variables —
`ENABLE_PATTERN_RULES`, `ENABLE_STOP_REVIEW`, `ENABLE_COMMIT_REVIEW`,
`ENABLE_CODE_SECURITY_REVIEW`, `SECURITY_GUIDANCE_*`."

The plugin ships **no other configuration channel** — `security-guidance.md` gives only environment
variables — so this is the only way to turn one review layer off or pick the review model. A
host-run command hook inherits exactly six names; a hook that Claude's own SDK runs inside its child
inherits the whole environment. That is why the three runtimes disagree on one plugin: the same
`ENABLE_STOP_REVIEW=0` works on claude and is inert on Pi and codex. A hook's own `actionEnv` can
still override per hook, so this is about the user's ambient environment, not about all env.

Evidence: `packages/shared/src/automations/hook-command.ts:36`
`const SAFE_INHERITED_ENV_KEYS = ['HOME','PATH','SHELL','TMPDIR','TEMP','TMP']` (re-read at HEAD),
consumed at `:64-67` as the only inheritance from `process.env`; the claude arm is
`packages/shared/src/agent/claude-agent.ts` symbol `chatImpl` building the options and `packages/shared/src/agent/claude-agent.ts` symbol `ensureLiveSession` calling
`query({…})` — hooks declared in the SDK's own settings tiers run inside that child and inherit its
whole environment. (Citation corrected: the reader's line 3168 of `claude-agent.ts` was a docblock about the
loopback API-key proxy.) Triage F32.3, the env half of F32.6.

**Options.**

- **(A) Keep the six-key allowlist** — buys: the smallest possible attack surface on a shell-out we
  spawn, no list for anyone to keep correct, and `PATH` stays the only execution-relevant name;
  costs: plugin env configuration stays impossible on Pi and codex forever, and the divergence with
  claude — where it works — stays, so the security plugin is configurable on one runtime of three.
- **(B) An operator-configurable passthrough allowlist of NAMES** — buys: the same plugin
  configuration works on all three runtimes, the operator decides which names cross, and the
  divergence closes in the direction of the runtime that already has it; costs: a list somebody has
  to keep correct forever, and it becomes the ONLY containment for a hook child, since the sandbox
  route is closed by the 2026-08-12/13 standing decision.
- **(C) Inherit the whole environment on all three** — buys: exact parity with the claude arm, zero
  configuration, every plugin's documented env config works everywhere; costs: every secret in the
  user's shell reaches every hook command any plugin ships, and `PATH`/`NODE_OPTIONS`-class names
  cross with no gate — a strictly larger surface than claude's, because claude's is at least scoped
  to hooks the SDK's own settings tiers declared.

**Recommendation:** **(B)**. It is the only option that closes the difference rather than choosing a
side of it, and it matches the native-first ordering: claude's mechanism is inheritance, so the host
supplies inheritance once, bounded. Note the tension with owner sitting §1.2, whose controller
recommendation is (A)-refuse for the *settings* `env` block on the grounds that an allowlist is a
list somebody must keep correct against a threat model whose worst item is `PATH`. These are
different seams — §1.2 is a settings key applied to the AGENT process, this is ambient environment
reaching a HOOK child — but the containment argument is the same one, so answer them together, and
if §1.2 lands on (A) the consistent answer here is (A) with the divergence disclosed rather than (C).

**Parity direction:** (B) closes it uniformly; (C) closes it by levelling up to the loosest arm;
(A) leaves claude ahead and must then be DISCLOSED as a switch cost — a `SECURITY_GUIDANCE_*` value
that governs on claude and governs nothing on Pi or codex is exactly the silent divergence this fork
counts as its largest defect class.

### [host] Should a session watch a merge request's CI, and may an agent act on what it sees?

*(denominator slice H#0)*

Closes denominator **H20** [pi] [claude] [codex] — `absent` on all three, size L.

Native mechanism, asked: none in any runtime. Upstream drives this with the `gh` CLI from the host; our
contour is GitLab, and `dpGitlab` exists in the developer harness and in ZERO product files, so the host
would build against GitLab's API. Re-measured at HEAD, because the reader's citation did not reproduce:
`autoFix` occurs nowhere under `packages/` or `apps/` (`git grep -ain -i autofix` → 0; the tree-wide hits
are three docs files), `autoMerge\|auto-merge` → 0, and `gh pr\|gh run\|pipelineStatus\|checkRun\|ciStatus`
→ 0 over `packages` + `apps/electron/src`, against the control `gitStatus` → 43 files. Coverage map row 183
names `/autofix-pr` among *"cloud or TUI surfaces we do not ship"*; page anchor
`#monitor-pull-request-status` VERIFIED.

- **A — status and notification only** — buys: the user sees pipeline results without leaving the session, and the agent never acts on them; no new authority, no receipt mechanism owed; one poller and one notification, and the session can auto-archive when the MR merges or closes — costs: a red pipeline still needs the user to ask for a fix, so the loop upstream advertises stays open.
- **B — A plus Auto-fix that iterates on failures** — buys: the failing-pipeline loop closes without a human in it, which is the capability's actual value — costs: an agent that pushes commits in response to an external system's output, unattended; every push is a side effect no permission prompt sees, and the ledger has no receipt shape for "the agent changed the branch while you were away".
- **C — B plus Auto-merge on green** — buys: full parity with the page — costs: the agent merges. That is a product posture, not a feature; a wrong green merges a wrong change, and nothing in this fork records who decided.

Recommendation: **A**. An agent that merges is a safety posture the ledger has no receipt mechanism for, and
Auto-fix's unattended pushes want the same receipt before they are worth having.

Parity direction: **C** closes the difference with the page; **A** leaves it open and HONEST — the status bar
that exists says what it does and does not do. If A is chosen, the residue must be named in the surface, not
left silent.

### [host] Fork mode's default: match both halves of the documentation, or keep one constant and rewrite the reason?

*(denominator slice H#0)*

Closes denominator **H28** [pi] [claude] [codex] — `partial` on all three, size S.

Native mechanism, asked, and it differs per runtime: Pi is ours (`NESSY_FORK_SUBAGENT`, mechanism BUILT and
defaulting OFF at `packages/shared/src/config/background-task-settings.ts:57-59`, read through
`packages/server-core/src/sessions/SessionManager.ts` symbol `forkSubagentModeEnabled`); claude-runtime takes the SDK's own default, which the page says is OFF for the
Agent SDK, so our `false` is doc-correct there; codex has `thread/fork`, which forks a THREAD, not a subagent
inheriting the parent's cache (`packages/codex-protocol/generated/ClientRequest.ts:100`). The fork agent
itself exists (`packages/shared/src/agents/definitions.ts` symbol `FORK_AGENT_NAME`, and the same file's symbol `isForkAgentName`).
The recorded reason for `?? false` has EXPIRED: the page now gives a version and a hard default
(`sub-agents.md#turn-fork-mode-on-or-off`, sentence at `sub-agents.md:1104`; its five old line anchors are
dead). No pre-existing ruling in the plan's `## Owner decisions` or in the out-of-scope register.

- **A — Pi defaults ON in interactive sessions, claude stays OFF** — buys: each runtime matches the documentation written for it; a Pi `fork` subagent inherits the conversation and the prompt cache the way the page describes, and the claude arm keeps the SDK's own documented default — costs: one more runtime difference, so it owes a `RuntimeSwitchCostRow`; and a fork inheriting the full conversation raises the per-child context cost on the default runtime.
- **B — keep one constant across all three and rewrite the justification** — buys: no switch difference at all, and the simplest thing to explain — costs: the reason on file has expired, so a fresh reason must be written and it will not be the page's; Pi users lose the prompt-cache inheritance the page treats as the interactive default.

Recommendation: **A**, with the switch-cost row written in the same commit. The documentation now states two
different defaults for two different shapes, and matching each is cheaper than defending one constant against
a page that contradicts it.

Parity direction: **A** closes the difference with the documentation while opening one at the switch — which
is exactly the case the switch report exists for. **B** keeps the runtimes uniform and all three wrong.

### [host] Should the product ship a bundled workflow command out of the box?

*(denominator slice H#0)*

Closes denominator **H42** [pi] [claude] [codex] — `absent` on all three, size M.

Native mechanism, asked: none on any runtime — a bundled workflow is CONTENT we would author. Pi is the only
runtime that can execute one (`packages/shared/src/workflows/workflow-keyword.ts` symbol `WORKFLOW_KEYWORD_DISPATCH_RUNTIMES`), and the
page's own example (`/deep-research`) needs WebSearch, which ledger J10 records `absent` on claude and codex.
Reproduced: `git grep -anIi 'deep.research' -- ':(glob)packages/**' ':(glob)apps/**'` → 0;
`packages/pi-agent-server/src/orchestrator/workflow-recipes.ts` is a 24-line in-memory registry whose
`registerWorkflowRecipe` (`:17`) has NO caller anywhere in the tree; positive control — the file loader does
find user and project recipes (`packages/shared/src/workflows/workflow-loader.ts` symbol `loadWorkflowRecipes`).

- **A — none: workflows stay user-authored** — buys: no token surprise from a command a user did not write, nothing to maintain against a moving page, and no capability that works on one runtime and not the others — costs: no first-run demonstration, so the workflow engine is invisible until someone reads the docs and authors a recipe.
- **B — one bundled workflow, on Pi, refused by name elsewhere** — buys: the engine demonstrates itself out of the box on the default runtime — costs: it needs WebSearch, absent on claude and codex (ledger J10), so it becomes a Pi-only capability with a named refusal on two runtimes; and a shipped recipe is content the product must keep working.

Recommendation: **A**, consistent with the owner's 2026-09-01 rulings (plan rows 25–47) against shipping
content the user did not ask for.

Parity direction: **A** is the parity-preserving answer here — B would create a new one-runtime capability.
The difference it leaves open is with the page, not between runtimes.

### [host] A budget a long task paces itself against: USD, tokens, or both?

*(denominator slice H#0)*

Closes denominator **H47** [pi] [claude] [codex] — `absent` on all three, size M.

Native mechanism, asked on each runtime and the answers do not agree. claude: `Options.taskBudget` is present
in the vendored bundle (`sdk.d.ts:1717`) with ZERO production references — this arm is configuration, not
construction. codex: its own config schema carries `token_budget`, `rollout_budget`, `max_goal_token_budget`
and `unified_image_budget`, plus `ThreadGoal.tokenBudget`/`tokensUsed`/`timeUsedSeconds` and a
`budgetLimited` status (`packages/codex-protocol/generated/v2/ThreadGoal.ts:6`), and ZERO usd/dollar keys —
measured in the docblock at `packages/codex-responses-adapter/src/config-writer.ts:2466-2490`: *"THERE IS NO
USD CEILING TO WRITE HERE… Every codex budget knob is denominated in TOKENS… Closing codex's half needs a
COST SOURCE first"*. Pi: a USD per-turn cap only (`spawner.ts:346`), no token budget. The owner ruled COST
2026-08-24 (plan `:285`); the DENOMINATION is unruled, which is what this asks.

- **A — express both: keep the USD cap where a price exists, and add a token budget every runtime can honour** — buys: the capability lands on all three (codex included) because tokens are the one unit every runtime denominates in, while USD keeps working where a price is known — costs: two budgets to explain and to display, and a user can hit either one first.
- **B — token budget only, everywhere** — buys: one unit, one display, identical behaviour on all three; codex needs no cost source at all — costs: the existing USD cap and its `child-session-max-budget-usd-exhausted` spawn refusal are re-expressed or retired, and a user who thinks in money loses the ceiling they set.
- **C — leave codex uncapped and keep USD on the other two** — buys: nothing to build now — costs: a token budget the model paces itself against is exactly the capability the page describes, and it stays absent on all three; codex users get no ceiling of any kind.

Recommendation: **A**. Tokens are the only unit codex can honour, and its own goal type already carries
`tokenBudget`/`tokensUsed`, so the visible half ("see the budget being spent") is a readback rather than a
build.

Parity direction: **A** and **B** both close the runtime difference; **A** does it without retiring a control
that works today. **C** leaves the difference open on the runtime that has the native knob. Adjacent and
already asked: `…ledger-closure-owner-questions.md` §[codex] *Codex ships a USD readback of its own: wire it,
or hold the ruled explicit null?* decides whether codex has a USD subject at all — answer that one first, and
this question's A becomes cheaper or narrower depending on it.

### [host] May one request fan out into 5–30 worktree-isolated agents that each open a merge request?

*(denominator slice H#0)*

Closes denominator **H51** [pi] [claude] [codex] — `absent` on all three, size L.

Native mechanism, asked: none on any runtime — upstream ships `/batch` as a bundled SKILL over subagents and
worktrees, so it is host-authorable, and we already have both ingredients: 32 files matching `worktreeLease`,
the spawner, `packages/server-core/src/pi-harness/worktree-include-plan.ts`, and an MR tool.
`git grep -a "'/batch'" -- packages apps` → 0 files. Page anchor: `agents.md` intro list. Adjacent ruling
already made: plan `:1145` sent the draft-MR half of background git to *"a separate forge/git-UI plan together
with the git panel and integrated terminal (Dev-4)"*.

- **A — MR-less batch: worktrees and branches, a human opens the merge requests** — buys: the whole parallel-execution value (5–30 isolated agents, each with its own branch) with no unattended forge writes, and it respects DR-2's routing of forge work to Dev-4 — costs: the last step is manual, so a 30-way batch ends in 30 branches somebody has to submit.
- **B — full batch with a per-MR confirmation** — buys: the page's capability end to end, with a human still in the loop once per merge request — costs: 30 confirmations is a prompt storm that trains the user to click through, which is worse than no gate; and it builds forge integration in this plan rather than in Dev-4, where it was ruled to live.
- **C — not now** — buys: nothing built, no posture taken; the ingredients keep working for hand-driven fan-outs — costs: the one capability that turns our existing worktree machinery into a product feature stays unbuilt.

Recommendation: **A**. DR-2 already routed forge work elsewhere, and A is the half that does not need it.

Parity direction: **B** closes the difference with the page. **A** closes the execution half on all three
runtimes uniformly (the fan-out is host-side) and leaves the forge half open, HONESTLY, to Dev-4.

### [host] `/cd` — may a live session move directory, and if it does, whose configuration governs it afterwards?

*(denominator slice I#0)*

**Denominator ids closed:** I20 (`partial` on Pi, claude and codex — the rules half is built, the command
half exists nowhere, the event half is Pi-only).

**What exists at HEAD.** The RULES half is real and enforced: `packages/shared/src/agent/permissions-config.ts:655-658`
compiles `Cd(/x)` to a `cdPath` carrying the same anchor, gated in server-core
(`packages/server-core/src/sessions/__tests__/cd-permission-gate.test.ts`, `cd-refusal-names-rule.test.ts`).
The COMMAND half is absent on every runtime — no `/cd` handler in any `*.ts`/`*.tsx`. The EVENT half is
Pi-only — `CwdChanged` is emitted from `packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:277`,
declared at `packages/shared/src/automations/types.ts:166`, and NOTHING re-resolves settings, hooks, MCP,
plugins or skills off it. Native mechanism, asked per runtime: the claude SDK exposes no mid-session
working-directory control that also re-reads project configuration; codex's generated protocol
(`packages/codex-protocol/generated/v2/`) carries no thread-cwd-change request; Pi's working directory is
a host record held by `WorktreeLeaseService`. So this is host work whichever way it is answered.

**Why it is an owner call and not a lane's.** The page's own capability re-reads the target directory's
`CLAUDE.md`, project settings, hooks, `.mcp.json` servers, plugins, skills, subagents and `env`. Moving a
live session therefore SWAPS the hooks that gate its tool calls and the MCP servers it can reach, mid
conversation, on the strength of one command — a user-visible safety posture, not a convenience.

**Options**

- **A. Decline the command; keep the `Cd` rules as a permission vocabulary only** — buys: nothing new can move a live session's trust boundary, and the rules already built keep their meaning for anything that later needs them; costs: a documented capability stays absent on all three, and the `Cd` rule family goes on compiling for a command that does not exist, which is itself a control nobody can reach.
- **B. Move the working directory only — re-resolve NOTHING — and say so in the result** — buys: the small honest thing; one host implementation for all three runtimes, no trust boundary moves, and the `Cd` rules gate the move exactly as written; costs: it is not the documented capability — a user who cds into another project keeps the first project's hooks, MCP servers and skills, and only a diagnostic line tells them.
- **C. Move and fully re-resolve the target's configuration, behind an explicit confirmation card naming what changes** — buys: the documented behaviour, uniform on all three, with the swap made visible at the moment it happens; costs: a second configuration-resolution path beside session start (every hook, MCP, plugin, skill and `env` source re-read live), and a card the user can click through — the largest build in this group after the handoff row.

**Recommendation:** B now, with the residue stated in the result line, and C only if an operator asks for
it. B is the smallest thing that makes `Cd` rules mean something; C is the full capability and should not
be bought before someone wants it.

**Parity direction:** the absence is UNIFORM today (all three `partial` in the same way), so no switch
divergence exists to close — this is a capability gap. B and C both close it on all three at once because
the seam is the host's. A keeps the uniform absence and owes only that the product say so where the `Cd`
rule is edited. Whichever is chosen, the Pi-only `CwdChanged` emitter must not become the mechanism —
that would manufacture exactly the silent divergence the native-first rule forbids.

### [host] Does the product ship per-dimension sandbox escape valves, or stay with one coarse valve?

*(denominator slice I#0)*

**Denominator ids closed:** I28 (`absent` on Pi, claude and codex).

**What exists at HEAD.** Claude carries all four documented valves as settings keys — a MITM-proxy CA, an
unprivileged nested container, macOS Apple Events, and Unix sockets — behind the `sandbox` option we never
pass. Non-test grep over `:(glob)packages/**/*.ts` + apps: `enableWeakerNetworkIsolation` 0,
`enableWeakerNestedSandbox` 0, `allowAppleEvents` 0, `allowAllUnixSockets` 0, `httpProxyPort` 0,
`socksProxyPort` 0 files; `allowUnixSockets` → 1 file and NOT a reader of this key
(`codex-protocol/generated/v2/NetworkRequirements.ts`, a generated codex type). POSITIVE CONTROL
`excludedCommands` → 11 files. Pi's `excludedCommands` is our only valve and it is COARSER by kind: it
removes the command from the boundary entirely rather than widening one dimension of it. The deny-side
counterpart is `session-tools-core/src/runtime/mach-services.ts:1-10`, `:38-44` — a deny, not a switch.
Codex has none.

**Why it is an owner call.** Each valve is the difference between a tool call running and failing inside
the boundary, so it changes what the agent can do. `allowAppleEvents` additionally removes code-execution
isolation on macOS — that is a safety trade, not a convenience — and the four are not one decision.

**Options**

- **A. Keep `excludedCommands` as the single valve, and disclose that widening is all-or-nothing per command** — buys: no new safety vocabulary, one concept to reason about, and the honest surface is a sentence rather than a subsystem; costs: an incompatible tool can only be fixed by removing it from the boundary entirely, which is strictly weaker than widening one dimension — the coarse answer is the LESS safe one here.
- **B. Add the container and proxy keys only, and refuse `allowAppleEvents` permanently, by name** — buys: the three dimensions that widen without removing code-execution isolation, uniform host-side across the runtimes that have an OS boundary, with the fourth refused out loud rather than silently unimplemented; costs: three new settings keys to schema, map, doctor and document, and a permanent divergence from Claude's published set that must be stated where an operator reads it.

**Recommendation:** B. A is the status quo dressed as a decision, and it is the weaker safety posture
because `excludedCommands` deletes the boundary for a command where a dimension key would only widen it.

**Parity direction:** UNIFORM absence today. B closes it on Pi and on claude wherever an OS boundary
exists and leaves codex the stated residue; A closes nothing and converts the gap into a disclosure. The
refusal of `allowAppleEvents` is itself a switch verdict and must reach the gaps doc, or B manufactures a
silent divergence from Claude's documented set.

### [host] Is containerised execution a direction for this product at all?

*(denominator slice I#0)*

**Denominator ids closed:** I31 (`absent` on Pi, claude and codex).

**What exists at HEAD.** Nothing, and there is NO existing ruling: `grep -an container` over the whole plan
returns a CI verification container (P2.188/P3.128) and a coreutils probe (P3.307); the standing
isolation-off decision is cited at P3.76 and is about the seatbelt, not a process boundary; sitting §1.1 is
the seatbelt row. Native mechanism, asked per runtime: claude's `Options.spawnClaudeCodeProcess` exists as
a page-documented option (`agent-sdk/typescript` §options) and is reproduced here in ONE test file and two
spec documents with no production caller (`git grep -aln spawnClaudeCodeProcess` →
`docs/superpowers/specs/2026-08-28-runtime-feature-inventory.md`,
`docs/superpowers/specs/2026-09-02-host-coverage-by-runtime.md`,
`packages/shared/src/agent/__tests__/claude-turn-cancel-contract.test.ts`); Pi and codex are both spawned by
the host itself, so the seam is our own spawner rather than a runtime option — a category-2 capability, not
three builds.

**Why it is an owner call.** It decides what the agent can touch at all, and today the answer is the same
on all three only because nobody has it. It is also an operator cost (an image to build, ship and keep
current) and a product posture, not a lane's choice.

**Options**

- **a. Build it once in the host spawner, for all three runtimes** — buys: one boundary that covers the whole agent process — built-in file tools, MCP servers and hooks, not only Bash — identical on every runtime by construction, and it is the only option that survives a runtime switch unchanged; costs: an image and its lifecycle, filesystem and credential plumbing into the container, and a materially different debugging story for every existing live case.
- **b. Use claude's `spawnClaudeCodeProcess` hook and leave Pi and codex on the host** — buys: the smallest code change, using the runtime's own documented option; costs: it is the shape native-first exists to forbid — one runtime isolated and two not, a divergence created deliberately at the exact seam a user switches across.
- **c. Not now; record the absence as uniform and keep the seam clean** — buys: nothing to maintain, and the standing isolation-off decision stays coherent; costs: an operator who needs process-level isolation has no path at all, and the product does not say so anywhere.

**Recommendation:** a or c, never b.

**Parity direction:** UNIFORM absence today. Option **a** closes it on all three at once. Option **b**
OPENS a divergence and would owe a switch verdict and an honest surface the moment it landed. Option **c**
keeps the uniform absence and owes only a line where an operator looks.

### [host] Windows: keep the weaker `unelevated` sandbox, or spawn codex's own setup binary for `elevated`?

*(denominator slice I#0)*

**Denominator ids closed:** I32 (Pi `absent`, claude `n/a` — the supervisor path is Pi-only, codex
`unknown`).

**What exists at HEAD.** Pi writes the weaker mode as an UNCONDITIONAL LITERAL:
`packages/server-core/src/pi-harness/isolation/windows.ts:118-120` emits `[windows]` / `sandbox = "unelevated"`.
claude is `n/a` — `processSupervisor` = 0 in `claude-agent.ts` and 0 in `codex-agent.ts` against 3 in
`pi-agent.ts` (control). codex is unknown because we emit no `[windows]` block at all — one tracked
non-generated `[windows]` hit repo-wide and it is that Pi file — so codex's own default governs and
`Constrained<T>` clamps it to an administrator's `allowedWindowsSandboxImplementations`
(`codex-config-requirements.ts:368`, `:233`). NATIVE MECHANISM, and it is a BINARY we already ship and never
run: `codex-windows-sandbox-setup.exe` (strings `provision-only`, `sandbox_users.json`,
`setup_marker.json`, `.sandbox-secrets`) is resolved and hash-verified at
`backend/internal/runtime-resolver.ts:178-183` — existence check only, `setupCommand` 13 hits and ZERO spawn
sites. The RPCs are real and pinned (`generated/v2/WindowsSandboxSetupStartParams.ts:7`,
`WindowsSandboxSetupMode.ts:5`) and `windowsSandbox/readiness` has 0 non-generated call sites against
control `thread/start` = 50 — the Pi harness does not speak that protocol. Shipped-binary evidence
(strong): `elevated` 52 / `unelevated` 12 in `win32-x64/codex-app-server.exe`, `elevated` 89 in
`codex.exe`, negative control `zzz_not_real` 0. Page `learn.chatgpt.com/docs/windows/windows-sandbox.md#configure-the-windows-sandbox`
(weak). UNRULED: `elevated` scores 0 in the plan's owner sections and 0 in the out-of-scope register.

**Why it is an owner call.** Provisioning the elevated sandbox creates local sandbox users and a secrets
store on the user's machine — an operator cost and a first-run experience, not a lane's call.

**Options**

- **A. Keep `unelevated` and record the divergence honestly** — buys: nothing to provision, no first-run privilege step, and today's behaviour is already this; costs: Windows users run every supervised command in the weaker boundary while the stronger one ships in the box, and the literal that decides it is unconditional and unexplained.
- **B. Spawn the setup binary for an OPT-IN `elevated` mode, falling back to `unelevated` with a named diagnostic** — buys: the stronger boundary for anyone who asks for it, using the vendor's own provisioning binary we already ship and hash-verify — native-first, tier 1; costs: a provisioning step with local sandbox users and a secrets file, a readiness protocol the Pi harness does not speak today, and a two-state Windows posture to document and support.
- **C. Always attempt `elevated`, falling back silently** — buys: the strongest default with no user decision; costs: a privileged provisioning step nobody consented to on first run, and a silent fallback is exactly the silently-stops-controlling shape this sweep exists to find.

**Recommendation:** B.

**Parity direction:** the weakness is Pi-only today and codex's arm is unmeasured, so this is already a
divergence in the making. B closes it on the Pi path and OWES the codex arm: whichever mode is chosen must
be written into the codex config too, or the two Windows paths diverge under one setting. A keeps the
divergence and owes the disclosure. The `unknown` codex cell must be measured under any option — it is the
`[windows]`-block absence, and it is one grep against the shipped binary plus one config read.

### [host] Governing the built-in browser — per-site approval and the CDP grant

*(denominator slice J#0)*

**Closes ledger cells:** J12 (pi `partial`, claude `partial`, codex `absent`), J14 (pi `absent`, claude `absent`, codex `n/a`). Not on the sitting page (`browser` occurs in none of its 17 sections). Distinct from the existing question `#codex-may-a-codex-turn-drive-the-built-in-browser-and-who-pays-for-the-gate`, which decides whether codex reaches the pane at all; this one decides what governs the pane for the two runtimes that already have it.

Native mechanism, asked and answered: **none.** Anthropic's is a hosted classifier plus a device-local trust store, and the pane is our own Electron surface, so any control is host-supplied for all three. What exists today is a per-COMMAND gate — plan mode blocks state-changing browser commands and the don't-ask-again hash is keyed on the command, never on the site or the origin — plus one managed all-or-nothing kill switch. `git grep -aiE 'siteAllowlist\|domainAllowlist\|perOriginApproval'` over packages+apps → 0; `persistBrowsingSession` → 0 (`browserPane` → 50 files as the control). Full CDP is attached with no grant at all: `apps/electron/src/main/browser-cdp.ts:1-13` attaches `webContents.debugger` for a11y snapshots and element interaction with no per-origin check and no setting; `browser_use_full_cdp_access` appears only in the vendored `packages/codex-protocol/schema/config-schema.json`. Navigate entry point `packages/server-core/src/handlers/browser-pane-manager-interface.ts:226`; managed off switch `registerManagedInAppBrowserDisabledProvider` (`packages/server-core/src/bootstrap/managed-policy-resolution.ts:273-280`, P2.399) and `packages/shared/src/agent/claude-managed-settings.ts` symbol `disableInAppBrowser`. Pages: `desktop (#22)` anchors `#browse-external-sites` and `#approve-claude’s-actions-on-a-site` (the apostrophe survives the slug), `whats-new/2026-w28`, `row 18 · browser`. Codex note: P2.373 measured that codex does not act on its own `in_app_browser` flag at all, so the gate had to be ours in any case.

**Question.** What governs the agent's use of the built-in browser outside the project's own pages — and is full Chrome-DevTools access a grant of its own?

- **Nothing beyond today's managed kill switch; CDP stays implicit** — buys: no new prompts on a live feature, no trust store to build, keep, migrate or revoke, and the operator retains the one control that already works. — costs: an agent can navigate to any origin and attach an unbounded DevTools debugger to it with no record and no user decision, on the default runtime; the "which sites did it touch" question has no answer at all.
- **A host per-origin trust store: one card (Allow once / Always allow / Deny, per subdomain, revocable) gating both the first navigation to a new origin and the first full-CDP attach on that origin, plus a managed lock beside `disableInAppBrowser`** — buys: the smallest honest thing that closes the parity difference — the user is asked before the agent acts on an external site, the administrator can lock CDP off separately from the pane, and one list serves both the card and the operator allowlist the J15 row builds. — costs: a new prompt surface on a feature that today prompts per COMMAND, so existing Pi and claude users see approvals they have never seen; a trust store to persist, scope and revoke; and per-subdomain semantics to get right once, publicly.
- **Option 2 plus a host classifier band over external-origin write actions (click / type / submit) and a browsing-session persistence choice** — buys: the full documented shape, including the half that catches a page trying to drive the agent rather than the agent choosing a bad origin, and an explicit answer to whether cookies and logins survive the session. — costs: a classifier we do not have — the vendor's is hosted, so this is either a model call per write action (latency and spend on every click) or a rules list that will be wrong in both directions; plus a persistence setting whose default is itself a privacy posture.

Recommendation: **option 3 as the destination, option 2 as the thing to build first.** Option 2 is separable, needs no model, and closes the parity difference on its own; the classifier band and the persistence choice in option 3 are a clean increment on top of the same trust store rather than a rewrite. Do not ship option 3's classifier before option 2's card exists — a band with no origin record has nothing to attach a verdict to.

*Parity direction:* options 2 and 3 close the difference (Anthropic's desktop has both halves; we have neither). Option 1 leaves it permanently open and, unlike most of this group, NOT honest — no surface tells the user or the operator that browsing is ungoverned. If option 1 is chosen, the honest-surface row it then owes is `[host] name the ungoverned browser reach in the switch report and the settings copy`, size S.

---

### [host] Channel opt-in: a per-session arming set, or the app-wide preference we have?

*(denominator slice J#0)*

**Closes ledger cell:** J20 (pi `partial`, claude `absent`, codex `absent`). Not on the sitting page; no MCP-channel row exists among the 168 unfinished tracker rows.

Native mechanism: **neither runtime has a per-session mechanism of its own**, so this is host case (2). The host already has the shape one axis short: `ChannelPolicy.allowedSources`/`deniedSources` (`packages/shared/src/mcp/mcp-pool.ts:515-531`) plus the managed `allowedChannelServers`, and `CHANNEL_PUSH_OFF` is fail-closed (`:535`). What is missing is SESSION scope — ours is a persistent global preference (`packages/shared/src/config/storage.ts` symbol `mcpChannelPushEnabled`, default `false`, read by `getMcpChannelPushEnabled`), resolved once per session at `packages/server-core/src/sessions/SessionManager.ts` symbol `resolveChannelPolicy`. The shape difference is recorded verbatim at `docs/superpowers/specs/2026-07-31-claude-coverage-map.md:353`. Page: `channels`.

**Question.** Should opting a server into channel pushing be a per-SESSION act, as the page documents, or stay the persistent app-wide preference we built?

- **Keep the global preference** — buys: nothing to build, one place to reason about, and the fail-closed default already protects a user who never opts in. — costs: an opt-in made for one piece of work is permanent and invisible thereafter; a server that may push text into a turn keeps that right in every future session on every project.
- **A per-session arming set, seeded from the persistent preference** — buys: the page's boundary without losing the fail-closed default or the managed allowlist; several servers armed at once; the grant expires with the session, which is the property that makes third-party text injection reviewable. — costs: two scopes to explain in one settings surface, and a seeded set means the persistent preference still grants by default, so the boundary is softer than the page's.
- **Per-session only — drop the persistent preference** — buys: the documented shape exactly; no standing grant can exist. — costs: a user who wants a channel every time re-arms it every time, which is the shape people switch off entirely.

Recommendation: **option 2.** It keeps `CHANNEL_PUSH_OFF` fail-closed and the managed `allowedChannelServers` intact, adds the session boundary the page specifies, and is the only option that does not either strand a standing grant forever or tax the user on every session.

*Parity direction:* options 2 and 3 close the difference against the documented shape. Note that whichever is chosen, the ARMING is Pi-pinned today — the row `an MCP channel is armed on policy alone and only on Pi` in `rows-J-0.md` (J19 + J29) must land first, or a session-scoped grant will exist on one runtime and be silently ignored on the other two.

---

### [host] Plugin-shipped message channels — allow third-party text injection into a turn?

*(denominator slice J#0)*

**Closes ledger cell:** J30 (pi `absent`, claude `absent`, codex `absent`). Searched for a prior ruling: the plan has 21 `channels` hits, all substring noise; the out-of-scope register has 0. No ruling exists.

Native mechanism: **none — no runtime supplies channel plugins itself.** Our own adapter recognises the component and records a deferral rather than failing: `packages/shared/src/plugins/format-adapters/claude.ts` symbol `CLAUDE_RETAINED_SURFACE_FIELDS` carries `{ externalKind: 'channel', field: 'channels' }` (the coverage map's `:2338` citation is stale by 117 lines), and `reasonCode plugin.deferred.claude_channel` → 1 file. Nothing consumes it. Pages: `channels`, `plugins-reference` — and AGENTS.md names `channels-reference.md` among the eleven plugin-format pages, so this is a documented component type we accept and drop.

**Question.** Should a plugin be able to ship message channels — declaring `channels` bound to its own MCP server, installed and enabled per session — so third-party content can be pushed into a turn?

- **Leave it deferred, and write the deviation** — buys: no path by which installing a plugin grants anything the right to inject text mid-turn; the deferral already exists and is already recorded per plugin; nothing to build, keep or review. — costs: a documented plugin component type stays permanently unimplemented, and a plugin author who declares `channels` gets a deferral notice rather than a feature.
- **Build it host-side for all three, gated on the plugin's hook trust grant** — buys: one implementation serving every runtime (the arming row J19/J29 is a precondition either way), reusing the trust decision the user already makes for a plugin's hooks rather than inventing a second consent. — costs: a plugin's MCP server gains the ability to put text in front of the model mid-turn on the strength of a grant the user gave for something else; the blast radius of "trusted plugin" grows in a direction nobody was asked about.
- **Allow it only where mid-turn steering already exists** — buys: the capability where the runtime can actually interleave it, and nowhere else. — costs: a plugin component that works on some runtimes and not others — the silent-divergence shape, and one that a plugin author cannot see from the manifest.

Recommendation: **option 1.** The deferral is already honest, the capability's whole value is injecting third-party text into a turn, and no user has asked for it. Revisit if a first-party plugin needs it, at which point option 2 with a channel-specific grant (not the hook grant) is the shape to price.

*Parity direction:* all three runtimes are `absent`, so nothing diverges today and option 1 keeps it that way. Option 3 would CREATE a divergence to close a gap that does not exist.

---

### [host] Image generation — leave codex's items rendered and unreachable, or give them an upstream?

*(denominator slice J#0)*

**Closes ledger cell:** J32 (pi `absent`, claude `absent`, codex `partial`). Not on the sitting page and not in the out-of-scope register.

Native mechanism, asked per runtime: **codex has the skill and the protocol items and we already render them (P0.6)** — `packages/shared/src/agent/backend/codex/event-adapter.ts` (`isImageItem`), the same file (`imageGenerationFailureMessage`), and its warning emission, interfaces at `:110-136`. What is missing is an upstream that can serve them: the writer pins codex's `base_url` to our loopback adapter over a gateway with no image model — `packages/codex-responses-adapter/src/config-writer.ts:2900` (`base_url = http://127.0.0.1:<adapterPort>/v1`; the citation was corrected from `:799`, which is an approval-mode comment). **Claude has nothing** — four identifiers probed in the vendored `sdk.mjs` → 0 each, control `readOnlyHint` → 1. **Pi corrected `partial` → `absent`**: `rg 'imagegen\|gpt-image'` over packages/apps `.ts` → 0; the only occurrence is the vendored `packages/shared/node_modules/@earendil-works/pi-ai/dist/image-models.generated.d.ts:348`, which DECLARES `openai/gpt-image-2` but with `api: "openrouter-images"` — an upstream this product does not have, and which doubles as the positive control that the grep sees the name. Page: `78 image-generation`.

**Question.** Do we offer image generation in the chat at all — including the documented explicit `$imagegen` invocation?

- **No: leave codex's items rendered-but-unreachable and write the deviation** — buys: no new upstream, no new spend path, no new content-policy surface; the failure is already named to the user rather than silent (`imageGenerationFailureMessage` is emitted as a warning), which is the honest-divergence shape. — costs: a codex user who asks for an image gets a warning forever; the capability is `partial` on one runtime and `absent` on two, permanently.
- **Route image turns to a BYO image model** — buys: the capability for anyone who brings a key, on the connection they already configured; no gateway dependency; and it is the same BYO seam the model picker already uses. — costs: a second modality through the loopback adapter (request shape, result shape, size limits, storage of the returned bytes); a content-policy question we have never had; and it works only for BYO users, so the default gateway card still cannot do it.
- **Ask the gateway to serve an image model** — buys: the capability for every user on the default card, with one upstream and one auth path we already have. — costs: not ours to decide — it is a request to another team with an unknown answer and no date, so it cannot be planned as a lane; and it still needs option 2's adapter work once the model exists.

Recommendation: **option 1 now, option 2 later.** Record the deviation and keep the warning; revisit the BYO route if a user asks. Option 3 is worth raising as a question to the gateway team in parallel, but it cannot be this plan's answer.

*Parity direction:* option 2 closes the difference for BYO connections on codex and would extend to the other two only if their adapters gained the same modality; option 3 closes it for everyone; option 1 leaves it open and REPORTED. Note that under option 1 the claude and Pi arms owe nothing — neither runtime has an image tool to render — so the only surface owed is the deviation entry.

---

### [host] Should `ultracode` be selectable as an effort posture, or stay keyword-only?

*(denominator slice K#0)*

Closes **K17**. Today `ultracode` is a host keyword only: typing the word triggers a dynamic workflow, and
nothing in the picker, no flag and no persisted key selects the posture. That the word is NOT a seventh effort
level is already a recorded decision at three sites, with a loud rejection pinned by a test — so the effort half
is closed and honest. The open half is discoverability: the page documents a settings key and a flag, and we
write neither.

- **Keyword-only opt-in (status quo)** — buys: no runaway spend, because the orchestration only starts when a user asks for it in words; the recorded max-effort decision and its loud rejection stay true; zero new surface, zero new vocabulary. — costs: the settings key and the flag the page documents stay absent; a user who never types the word never reaches the orchestration, and cannot discover that it exists.
- **A per-session Pi toggle beside the effort control, behind the workflows-off gate** — buys: the posture becomes discoverable and persists across turns; it matches the page's settings key; the existing workflows-off gate still switches the whole thing off. — costs: a standing orchestration budget the user did not price per turn — every substantive task fans out until the toggle is cleared; and a control sitting beside the effort picker will read as a seventh effort level, which is exactly the confusion the three recorded rejections exist to prevent.

Recommendation: **keyword-only**. The spend is opt-in per turn and the existing refusal is already honest.
Parity direction: the **toggle** is what closes the difference against the page (settings key + flag), at the
cost of the recorded max-effort decision and a standing budget.

Evidence: `packages/shared/src/workflows/workflow-keyword.ts:18` `WORKFLOW_TRIGGER_KEYWORD = 'ultracode'`; the
non-adoption is recorded at `packages/shared/src/automations/types.ts` (its docblock, line anchor decayed 2026-09-17) ("Nessy has no 'ultracode' effort
level"), `packages/pi-agent-server/src/orchestrator/spawner.ts:792-799`, and
`packages/shared/src/agent/thinking-levels.ts:232-234,268-276`, with `environmentThinkingOverrideRejection`
pinned by `thinking-env-tier.test.ts:96-101`; the level vocabulary is `thinking-levels.ts:34-41`
`['off','low','medium','high','xhigh','max']`. Native shape: the vendored SDK models it as
`ultracode?: boolean` (`sdk.d.ts:7206`, "xhigh effort plus standing dynamic-workflow orchestration") beside
`effortLevel?: 'low'|'medium'|'high'|'xhigh'` (`:7202`); 135 occurrences in the vendored binary; the page states
`CLAUDE_CODE_EFFORT_LEVEL` does not accept it. Pages `model-config.md#adjust-effort-level` (531), `workflows.md`.
Ledger line 1548: "the `ultracode` advertisement is closed in two of its three routes." Whether the SDK's own
`ultracode` flag is even reachable on a packaged claude session is P6.125's measurement, still open.

### [host] Ultra: should picking it change the run's SHAPE, and who decides the fan-out?

*(denominator slice K#0)*

Closes **K18**. Codex's own multi-agent switch is already on — we write `[features] multi_agent = true` plus the
`[agents]` role tables — so the capability exists. What is absent is any user-facing way to say "split this
across subagents". Today the model decides alone.

- **(A) Leave it to the model** — buys: no new control, no new failure mode; the model already has the roles and the switch, and a fan-out it did not choose is usually the wrong one. — costs: a user who knows the task is parallel cannot say so; "Ultra" as a label promises a run shape the product does not deliver.
- **(B) An Ultra position that raises the subagent ceiling** — buys: one control, uniform across all three runtimes, expressible on every runtime that has a ceiling; nothing new to model. — costs: a ceiling is permission, not instruction — raising it does not make the model fan out, so the label can still under-deliver; and it collides with the unset-case ceiling divergence already queued (P6.124, and the codex-ceiling question already on the owner-questions page).
- **(C) Ultra per role** — buys: the finest control, and it maps onto codex's `[agents]` role tables directly. — costs: it exists on codex alone, so it is a new switch-visible divergence unless Pi and claude grow an equivalent; and the operator now prices three fan-outs instead of one.

Recommendation: **(A)**. Parity direction: **(B)** is the only option that closes the difference uniformly on
all three; (C) closes it best on codex and widens the gap everywhere else.

Evidence: `packages/codex-responses-adapter/src/config-writer.ts:2743-2752` — `'[features]'`,
`multi_agent = true`, with the `[agents]`-LAST placement reason in the comment above it. PARTLY RULED already:
`multi_agent` is on the owner's 2026-08-22 default-take list (plan line 22) and is written. Ledger H4/H6 cover
concurrency ceilings and budget, neither covers choosing a fan-out; K2 is the effort ENUM reaching the runtime,
and Ultra is a run SHAPE. Source page `refute_codex_3` (row 85, models).

### [host] A plugin marketplace whose source is a local command

*(denominator slice L#0)*

Closes: **L20**. Verdicts: pi `absent`, claude `partial`, codex `absent`. Size M.

Our resolver refuses a `command` source — four classifications, none of them a command
(`packages/shared/src/plugins/source-resolver.ts` symbol `resolvePluginInstallSource`, `:147`, `:174`, `:216`). But claude-runtime is NOT absent:
we pass `settingSources: ['user','project','local']` (`packages/shared/src/agent/claude-agent.ts` symbol `settingSources`), so the SDK's own plugin subsystem
reads the user's `extraKnownMarketplaces`, and 2.1.233 added `command` as a marketplace-entry source — a surface
our host gate cannot reach. The documented off switch `disableCommandPluginSources` is already a managed key emitted
at its restrictive pole (`claude-managed-settings.ts:434-466`, emission `:1390-1392`; 14 occurrences in the lifted
2.1.233 bundle, 0 at 2.1.223). Codex's `marketplace/add` takes `{source, refName?, sparsePaths?}` and no command kind.

- **Keep refusing `command` in our catalog and say nothing more** — buys: nothing changes. — costs: the refusal is
  true of our catalog and false of the product — a user's `command` marketplace runs inside the claude child today
  and our plugin policy never sees it. That is the fork's largest defect class exactly.
- **Refuse uniformly and close the claude leak** — buys: one honest answer on all three; the managed key that does
  it is already written and only needs to be at the restrictive pole for this source kind. — costs: removes a
  capability the binary we ship has, and the user loses a documented 2.1.233 feature with no substitute.
- **Accept `command` in our own resolver, behind an approval** — buys: parity with the page and with the vendored
  binary, on all three. — costs: we execute a user-declared command to resolve a plugin directory — the same
  execute-a-declared-command trade as the `headersHelper` question, and it needs the same approval floor.

Recommendation: **option 2 now, option 3 only together with the `headersHelper` decision**. The seam that makes
option 3 safe is one approval floor for marketplace-declared commands; taking it twice, in two shapes, is how the
floor ends up with a hole.

Closes the difference: option 3 closes it toward the page; option 2 closes it toward uniformity across the three.
Sibling already asked: `2026-09-05-ledger-closure-owner-questions.md#[host] Should a marketplace's headersHelper
command be executed to mint an archive-download credential?`

### [host] One-click plugin install from a link

*(denominator slice L#0)*

Closes: **L21**. Verdicts: `absent` on all three. Size M.

Codex's is a custom URL scheme, `codex://plugins/install/<id>?marketplace=<m>`. We register exactly one scheme,
`nessy://` (`apps/electron/src/main/index.ts:194`, registered `:252`), whose policy deliberately refuses mutating
verbs from external origins — `apps/electron/src/renderer/contexts/deep-link-policy.ts:1-31`, "A link Nessy did not
produce is inert", with `EXTERNAL_BLOCKED_ACTIONS` holding seven verbs and no install verb existing to block. The
posture was reasoned in-tree and never written down as a divergence.

- **Keep the refusal and write it down** — buys: the strongest posture, unchanged; the honest surface it currently
  lacks costs one line. — costs: a marketplace page's install link does nothing in Nessy, on every runtime, and the
  user is left hand-copying an id.
- **Accept an install deep link that only PRE-FILLS the install dialog** — buys: the ergonomics without the
  mutation — the link navigates, the human presses install. — costs: a new external-origin verb in a policy whose
  whole value is that it has none; the dialog must survive a hostile `marketplace` parameter.
- **Accept it as a mutating verb for allowlisted marketplaces only** — buys: true one-click for internal
  catalogs. — costs: an external origin can install software; the allowlist becomes a security boundary.

Recommendation: **option 2**. It closes the ergonomic gap without giving an external origin a mutating verb, and it
keeps `deep-link-policy.ts`'s invariant literally true.

Closes the difference: options 2 and 3 close it toward codex's own affordance; option 1 keeps all three equal and
equally without it, which is a legitimate close by uniformity.

### [host] Should a plugin's output style apply itself?

*(denominator slice L#0)*

Closes: **L25**. Verdicts: `absent` on all three. Size S.

`output-styles.md#frontmatter` line 100 documents `force-for-plugin` and adds "If multiple enabled plugins set this,
Claude Code uses the first one loaded". The field is already PARSED and recorded as a deferral, so only the honouring
is missing: `packages/shared/src/plugins/format-adapters/claude.ts:995-1001` pushes an `output-style-force` deferral
with reasonCode `plugin.deferred.claude_output_style_force_for_plugin`; `packages/shared/src/capabilities/resolver.ts` symbol `RuntimeOutputStyleDefinition`
states "nothing here applies a style on its own"; `runtime-output-styles.ts:12` repeats it.

- **Keep the deferral, permanently, and surface it** — buys: no plugin can change how the assistant speaks without
  the user selecting it; the same unattended-default refusal the fork already applies to a plugin's `agent` key. —
  costs: a documented field stays inert on all three runtimes and the plugin author's intent is silently dropped.
- **Honour it, with the page's first-loaded tie-break** — buys: documented behaviour, identical on all three because
  the host owns prompt composition. — costs: enabling a plugin changes the assistant's voice with no user action,
  and the tie-break is order-dependent — the exact "unattended default" shape the fork refuses elsewhere.
- **Honour it as a PROPOSAL** — the plugin's style is offered and applied on one confirmation — buys: the author's
  intent reaches the user; nothing changes unattended. — costs: a third state in the output-style model, and a
  prompt at plugin-enable time.

Recommendation: **option 1**, kept consistent with the `agent`-key refusal (see the next question) and made visible;
if the owner wants the capability, **option 3** is the version that does not smuggle a default.

Closes the difference: all three options close it — the cells are equal today; the question is which pole.

### [host] Should a plugin ship default settings, including the `agent` key?

*(denominator slice L#0)*

Closes: **L26**. Verdicts: `absent` on all three. Size M.

The value is parsed, checked against the plugin's own agents, recorded as `deferred: settings-agent` and refused with
a warning: `packages/shared/src/plugins/format-adapters/claude.ts:2581-2626`, whose refusal text is
"a plugin silently replacing the main thread's system prompt, tool restrictions and model is the same unattended-default
move this fork already refuses for output styles". Claude could carry it through `buildClaudeRuntimeAgentOptions`, so
the refusal is a posture, not a missing seam. Prior record: f053 specs Step 1 (landed) and Step 2, which stops at
"only if the owner approves honouring `agent` at all".

- **Keep refusing the `agent` key; honour the rest of a plugin's default settings** — buys: a plugin can ship
  sensible defaults without being able to replace the main thread. — costs: the split needs a defended key list, and
  a plugin author reading the page sees a documented key refused.
- **Refuse the whole `settings` block** — buys: one rule, no list to maintain, no plugin-supplied default anywhere. —
  costs: the most useful half goes with the dangerous half.
- **Honour `agent` too, on first enable, behind an explicit confirmation naming what changes** — buys: full
  documented behaviour. — costs: a confirmation the user will click through, after which a plugin owns the system
  prompt, the tool restrictions and the model.

Recommendation: **option 1**. It preserves the refusal the code already argues for, and the same reasoning should
settle `force-for-plugin` above — one posture, stated once, for both unattended-default fields.

Closes the difference: all three close it; the cells are equal today.

### [host] Replacing or appending the model's base system prompt

*(denominator slice L#0)*

Closes: **L30**. Verdicts: `absent` on all three. Size M.

Claude has TWO native forms — `Options.systemPrompt` as `{type:'preset',preset,append}` (`sdk.d.ts:2048`) and
`SDKControlInitializeRequest.appendSystemPrompt` (`sdk.d.ts:3664`) — and we set only the preset form with our own
append (`packages/shared/src/agent/claude-agent.ts` symbol `buildClaudeTurnShapeOptions`); `appendSystemPrompt\|append_system_prompt\|systemPromptFile` → 0 files across
`packages/shared/src`, `packages/server-core/src`, `apps/cli/src`, `apps/electron/src` (positive control `systemPrompt`
→ 8 hits in `claude-agent.ts` alone). Pi's `PromptBuilder` is ours. Codex has `model_instructions_file` as a top-level
key and as a `ConfigProfile` field (`codex-rs/config/src/config_toml.rs:239` @ `rust-v0.148.0`), written in 0 places
outside the vendored schema — and our guidance already reaches codex additively through `developerInstructions`
(`codex-agent.ts:3169`, `:4643`, `:4670`). So the missing thing is the REPLACING form, not a missing channel.

- **Offer neither** — buys: our prompt composition stays the only one; codex's 20,751-char base prompt is never at
  risk (the trap P3.35 recorded and P6.173 is repairing). — costs: a documented per-invocation capability is absent
  on all three, and an operator with a house prompt has no route.
- **Offer APPEND only, on all three** — buys: a user/operator addition on top of the vendor prompt, deliverable
  natively on claude (`appendSystemPrompt`), on Pi through `PromptBuilder`, and on codex through the
  `developerInstructions` channel already live — three native mechanisms, no replacement anywhere. — costs: the
  append text lands in a different slot on each runtime, so its precedence differs at a switch and the switch report
  owes a row.
- **Offer append AND replace, replace refused on codex by name** — buys: full parity with `cli-reference` on the two
  runtimes whose prompt we compose. — costs: a replace silently deletes the safety and engineering sections
  (P6.171's floor) unless the floor is re-added after replacement; and the codex refusal is a permanent asymmetry.

Recommendation: **option 2**. Every runtime already has a native additive channel — this is native-first with no new
host machinery — and replacement is the form that both deletes codex's base prompt and can strip the safety floor.

Closes the difference: option 2 closes it additively on all three; option 3 closes it further on two and widens the
codex asymmetry. SEQUENCE after P6.171 (the safety floor's single producer), whose outcome decides whether a replace
could ever be safe.

### [host] Relative paths in `additionalDirectories`

*(denominator slice L#0)*

Closes: **L40**. Verdicts: `absent` on all three. Size S.

Ours is the single reader for all three (`getConfiguredAdditionalDirectories`), and the refusal is deliberate and
reasoned: `packages/shared/src/agent/additional-directories.ts:45-47` pushes
`additionalDirectories: ignoring relative entry "…" — use an absolute path.` and `continue`s, with the reason in the
function header at `:32-36` — "there is no unambiguous cwd at gate time, so resolving one would make the granted root
depend on where the app was launched from". Diagnostics go to `log.warn` only (`:92-94`). The page documents
`"../shared"`, `"../web"` (`large-codebases.md:282`). This is a posture question, not a defect — and it is DISTINCT
from sitting §1.4, which is the Pi arm and the memory opt-in, not path shape.

- **Keep refusing relative entries, and raise the diagnostic out of `log.warn`** — buys: a granted filesystem root
  can never depend on the launch directory; the user finally sees the refusal. — costs: a documented path shape does
  not work; a user copying the page's own example gets silence today and a warning after.
- **Resolve relative entries against the SESSION's working directory** — buys: the page's shape works, on all three,
  from one reader. — costs: the exact hazard the header names — the same settings file grants different roots
  depending on where the session started, and a permission grant is the worst place for that.
- **Resolve them against the settings FILE's own directory** — buys: the page's shape works and the resolution is
  unambiguous and stable — a project `.claude/settings.json` saying `"../shared"` always means the sibling of the
  project. — costs: it is not what the page means by "where the session started", so we would be documenting a
  deliberate difference.

Recommendation: **option 3**, with the difference written down. It gives the user the documented shape while removing
the launch-directory dependence the header refuses — the header's objection is to option 2 specifically, not to
relative paths as such.

Closes the difference: options 2 and 3 close it toward the page; option 1 closes it by uniform, visible refusal.

### [host] Background distillation of finished chats into durable memories

*(denominator slice L#0)*

Closes: **L49**. Verdicts: pi `partial`, claude `unknown`, codex `absent`. Size L.

Codex HAS the whole subsystem: `codex-rs/config/src/types.rs:288-319` `MemoriesToml` (exactly 12 fields at
`rust-v0.148.0` — `generate_memories`, `use_memories`, `disable_on_external_context`,
`min_rate_limit_remaining_percent`, `extract_model`, `consolidation_model`, `max_rollout_age_days`,
`min_rollout_idle_hours`, …), `config_toml.rs:441` `pub memories: Option<MemoriesToml>`. It is unreachable for a HOST
reason: `~/.codex/memories/` sits inside the ephemeral per-session `CODEX_HOME` we create and delete. Ours is
model-invoked only — `packages/session-tools-core/src/handlers/remember.ts:26-29`, the `nessy:auto:` marker is
appended by the tool, so nothing distils a chat on its own. We write two `[features]` keys and neither memories key.

- **Stay model-invoked on all three** — buys: nothing is written to durable memory that the model did not decide to
  write in the open; no background model calls, no background spend. — costs: a documented capability absent
  everywhere, and codex's own subsystem stays dead inside an ephemeral home.
- **Adopt codex's subsystem on codex, and leave Pi/claude model-invoked** — buys: native-first, no host build. —
  costs: a switch changes whether finished chats become memories at all, plus a second extraction model the user
  never chose — a new silent divergence unless the switch report and a setting carry it; and it needs a durable
  `CODEX_HOME` for `memories/`, which is a real change to the ephemeral-home decision.
- **Build one host distiller for all three, and switch codex's own OFF** — buys: one behaviour, one model choice, one
  spend, uniform at a switch; codex's `generate_memories = false` is the documented off switch and P6.166 is already
  writing that block. — costs: a host background model call per finished chat, its cost and its failure modes, and a
  quality bar we own.

Recommendation: **option 3**, sequenced after P6.166 (which already opens codex's `[memories]` block and is the
switch-verdict half). Option 2 is native-first in form but manufactures exactly the divergence the native-first rule
exists to prevent.

Closes the difference: option 3 closes it uniformly; option 2 closes the codex cell and widens the switch cost;
option 1 closes it by equal absence and owes the disclosure.

### [host] Should `openai/skills`, the vendor's own catalog of reusable skills, be known to the product?

*(denominator slice L#1)*

Closes: denominator **L63** (Pi `absent`, Claude `absent`, Codex `absent`). Nothing runtime-specific is missing — our own skills installer already accepts a git source; the catalog is simply not known to the product. Evidence: `openai/skills` = exactly 3 tracked files, all documentation or a type comment (`2026-08-22-codex-coverage-map.md`, `2026-08-29-codex-blocked-column-triage.md`, `packages/shared/src/skills/types.ts`), 0 production readers; control on the same corpus, `github.com/openai/plugins` = 21 files.

- **Ship it as a built-in catalog entry, default on** — buys: a named, curated skill installable in one act on all three runtimes through the git source we already accept, closing the gap uniformly; costs: a second default-on remote catalog whose contents we do not review, and an OpenAI-hosted supply-chain surface beside the plugin marketplaces in an internal fork.
- **Ship it as a built-in entry that is present but disabled, one click to enable** — buys: discoverability with an explicit user act, and the reserved-name protections (L14) still apply; costs: a first run still shows nothing, and "present but off" is a state the marketplace UI does not have today.
- **Decline, and keep only the generic git source** — buys: no new default trust and no new review burden; costs: the catalog stays invisible, every user hand-types a URL, and the capability stays `absent` on all three.

Recommendation: **B**. Parity direction: **A** is the option that closes the difference outright — one host entry, identical on Pi, claude and codex.

### [host] Is plugin INSTALL scope a user choice, or does one store plus enablement scope stand in for it?

*(denominator slice L#1)*

Closes: denominator **L79** (`partial` on all three), and it fixes the scope SET that denominator **L78**'s row implements. What exists is ENABLEMENT scope (global / workspace / project) plus a project file, not INSTALL scope; the RPC install handler takes no scope at all. Evidence: `grep -an scope packages/server-core/src/handlers/rpc/plugins.ts` → 0 hits at HEAD; enablement scopes at i18n `en.json:1292-1296`; `packages/shared/src/plugins/project-config.ts:14-20` (a project file "can never grant trust, credentials, provider auth, environment, filesystem roots or shell commands"); `packages/shared/src/plugins/types.ts:4` — the three-member enum is the whole space; `discover-plugins.md` lines 296-298.

- **Offer the choice at install time — for me / for this repository / for me in this repository only** — buys: the page's four-scope model, a home for L78's gitignored scope, and one host answer serving all three runtimes; costs: a decision at every install, and a store migration, because installs today carry no scope at all.
- **Keep one install store and extend only enablement scope** — buys: no migration and no new UI; costs: a plugin wanted for one repository is still fetched and stored machine-wide, and the documented `local` scope stays absent on all three.
- **Add the scope in the CLI only, defaulting to user scope in the app** — buys: provisioning and scripting get it with the CLI verbs L86/L87 build anyway; costs: two mental models for the same store, and the desktop user never sees the choice.

Recommendation: **A**. Parity direction: **A** — the store is host-owned and provider-blind, so one build moves all three columns at once.

### [host] Should the official Anthropic marketplace be delivered by default?

*(denominator slice L#1)*

Closes: denominator **L90** (Pi `absent`, Claude `absent`, Codex `absent`). Not a build: the host already has the delivery mechanism, and the vendored runtime's own auto-registration acts on ITS `known_marketplaces.json`, not ours. Evidence: `packages/shared/src/marketplace/registry-source.ts` symbol `ensureDeliveredMarketplaces` ("Idempotent, and safe to call on any read path"), called from `list()` at `:1573`; built-in registry i18n `en.json:1257` "Skills Market"; plan row P2.12 (`80d53ff28`+`cb70c7f1b`) — "the live install works end-to-end on HEAD: 7/7 agents, 1/1 skill, 1/1 hook — and 0/1 workflows"; `plugins/install.md#install-a-plugin (was line 29 of the retired discover-plugins page)`. Related but distinct: the auto-install OPT-OUT for the runtime's own copy is denominator L19 (a BUILDABLE S row, not this question).

- **Deliver it as a built-in entry, default on** — buys: the documented default behaviour, plugins available with nothing added by hand, identical on all three runtimes; costs: a default-on connection to a vendor-hosted catalog from a T-Bank-internal fork, and the L14 reserved-name protections become load-bearing.
- **Deliver it present but disabled, one click to enable** — buys: presence and discoverability without a default outbound trust; costs: the first run still shows an empty browse list, and the documented behaviour is still not what ships.
- **Decline: keep only the built-in "Skills Market" registry** — buys: no vendor catalog in an internal product, and one curated source; costs: a user following the vendor's own documentation finds nothing, on every runtime.

Recommendation: **B**. Parity direction: **A** closes the difference against the page; B closes it against the *user's* complaint at the cost of one click.

### [host] Should plugin suggestions read the session's own history — commands run, hosts fetched, files read?

*(denominator slice L#1)*

Closes: denominator **L93** (Pi `absent`, Claude `absent`, Codex `absent`), and it decides what denominator **L92**'s suggestion surfaces are allowed to say. Asked and answered in-tree already, on scope grounds: four of five signals need per-session history this fork records on no runtime, so implementing them would be four matchers that can never fire; the record is parsed tolerantly instead. Evidence: `packages/shared/src/marketplace/relevance.ts:20-28` (the scope decision, "four matchers that can never fire"), `:36-45` `PluginMarketplaceRelevanceV1.signals` typed with `cwd` only, `:44` `export type PluginRelevanceSignalKind = 'cwd'`; `plugins/org.md#recommend-plugins (was line 79 of the retired plugin-relevance page)`.

- **Record the four missing signals in a per-session relevance log** — buys: the page's whole matcher set fires, suggestions become worth showing, and one host record serves all three runtimes; costs: a new per-session behavioural record of commands, hostnames and file reads — a privacy and retention posture this fork has never taken — plus multi-lane storage and expiry work.
- **Add only the manifest-dependency signal, which needs no history** — buys: a second live matcher read from a file the host already opens, with no behavioural recording at all; costs: three of five signals stay dead and the suggestion stays weak.
- **Keep `cwd` only, and state the narrowing where the suggestion appears** — buys: nothing new to build; costs: the capability stays `absent` on all three and the page's own Note is half-honoured.

Recommendation: **B**. Parity direction: **A** — it is the only option that closes the capability, and it closes it host-side for all three at once.

### [host] Should Nessy accept Claude Code's own settings vocabulary for the interactive-mode keys?

*(denominator slice L#2)*

Closes: L126 (`spellcheck`, `emojiCompletionEnabled`, `keybindingFlavor`, `promptSuggestionEnabled`,
`vimInsertModeRemaps`, `autoContinueAtUsageLimit`; `partial` on Pi, Claude and Codex, because a user's pasted
`~/.claude/settings.json` is read for some families and these keys land in none of them).

- **Accept all six as compat aliases** — buys: a user who pastes their Claude Code settings file gets what they
  wrote, on all three runtimes, and the alias mechanism is chosen rather than invented — the tree already does this
  for another name pair (`NESSY_SAFE_MODE` / `CLAUDE_CODE_SAFE_MODE`, `shared/src/config/safe-mode.ts:63,:66`) —
  costs: two of the six have no host behaviour at all (`keybindingFlavor`, `vimInsertModeRemaps`), so accepting
  the NAME without the behaviour manufactures exactly the silent divergence this fork keeps closing.
- **Accept only the names we already implement, and diagnose the rest** — buys: `spellcheck` maps straight onto
  the built spell-check surface (`apps/electron/src/renderer/pages/settings/InputSettingsPage.tsx` symbol `handleSpellCheckChange`, `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` symbol `loadInputSettings`), so every
  accepted name does something, and each unaccepted one produces one honest line naming Nessy's own spelling or
  saying there is no equivalent — costs: five of the six still do not take effect; the user rewrites their file.
- **Accept none, and say so once** — buys: the cheapest possible change, one diagnostic at settings-load time,
  uniform on all three — costs: parity direction unmoved; the paste-your-file story stays broken.

Recommendation: option 2. It is transparent (every key either works or is named), simple (no new behaviour), and
it leaves option 1 reachable later. Option 1 is the one that closes the difference, and it should be taken only
once `keybindingFlavor` and `vimInsertModeRemaps` actually have host implementations to alias onto.

### [host] Does importing a setup include the conversation history and the project memories?

*(denominator slice L#2)*

Closes: L131 (`absent` on Pi, Claude and Codex; `claude-setup-import.ts:61` lists exactly five kinds, none of them
a chat or a memory). Codex's own `/import` is documented as unavailable "while connected to a local app-server
daemon", which is our topology — a page-only reading, so WEAK tier: intent, not measured behaviour.

- **Setup only, as today** — buys: the importer stays a bounded five-kind converter with a dry run and no store
  migration; nothing new can leak — costs: a switching user loses 30 days of context and their project memories,
  which is the part they actually notice on the first turn after switching.
- **Import memories, not chats** — buys: project memories are files our instruction readers already understand,
  so the write is the `cpSync` shape the skill kind already uses; the steering the model receives survives the
  switch, which is the half that changes what the model is told — costs: memory files can carry material the user
  did not mean to move into a new workspace, so the dry run needs a per-file preview, not just a badge.
- **Import both, with chats read-only** — buys: full continuity, the strongest switching story — costs: a chat
  store schema we do not own on any of the three runtimes and no native route to copy one (codex's own `/import`
  is unavailable on our topology); L-sized, and the evidence for the codex arm would stay weak.

Recommendation: option 2. It closes the arm that changes what the model is told, with a mechanism we already have
and can measure, and it leaves the store migration honestly unowned instead of half-built.

### [host] Is the importer a one-shot converter, or a standing link to the other agent?

*(denominator slice L#2)*

Closes: L132 (`absent` on all three; reproduced search — `claudeImport\|importAgentSetup` over packages and apps
hits only the two import components, the onboarding playground entry and two locale files, so the one-shot
converter is the only importer that exists).

- **One-shot, as today** — buys: no watcher, no re-run record, no drift semantics; the dry run is the whole
  contract and the failure modes are bounded — costs: a user who keeps using Claude Code watches the two setups
  diverge with nothing saying so, and an imported plugin or connection that still needs authorisation is never
  surfaced anywhere.
- **One-shot plus a re-run that diffs** — buys: the compute phase already produces a plan with create/merge/
  conflict badges, so re-running it against the current `~/.claude` is nearly free and answers "what changed since
  I imported" without any watcher — costs: a conflict policy becomes a product decision (whose edit wins when both
  sides changed), and the needs-authorisation card is still separate work.
- **A standing sync, with the authorisation card** — buys: the whole promise, including the card for an imported
  plugin or connection that still needs auth — costs: a watcher over a directory we do not own, a re-entrant apply
  path, and a new failure mode in which a change made in Claude Code silently changes Nessy's behaviour.

Recommendation: option 2, plus the authorisation card built as its own surface rather than as a consequence of
syncing. Option 3 makes an external directory a live input to our permission posture, which is the direction this
fork has spent the plan closing.

### [host] Which agents may Nessy import from, beyond Claude Code?

*(denominator slice L#2)*

Closes: L133 (`absent` on all three). A deferral already stands and this question is whether it still should:
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` §"Recorded deviations (harvested by P5.3)" — "Dev-13 Import sources beyond Claude Code
(Cursor, Cowork): later" — and `claude-setup-import.ts:34` "Cursor is deferred (Dev-13) and is not read here".
What has changed since Dev-13 is that a complete importer now exists for one source: scan → dry-run plan →
per-change create/merge/conflict badge → apply, mounted in Settings, onboarding and the playground.

- **Keep Dev-13's deferral** — buys: nothing new to maintain, and the importer's evidence stays strong because it
  reads one format we understand — costs: the one other agent our own product ships a runtime for, codex, cannot
  have its setup imported at all, so a codex user starting in Nessy imports nothing.
- **Add `~/.codex` only** — buys: our own adapters already read every target component type
  (`packages/shared/src/plugins/format-adapters/claude.ts`, `packages/shared/src/capabilities/native-sources.ts`),
  so only a `~/.codex` reader is missing, and codex is the one foreign format we can verify against open source
  and a shipped binary rather than a page — costs: one more reader to keep against `rust-v0.148.0`, whose upstream
  is already four minors ahead (P3.283).
- **Add codex, Cursor and Gemini CLI** — buys: the widest switching story, and the importer's UI is already built
  for it — costs: three foreign formats we do not drive; two of them could only ever be evidenced from pages, the
  weak tier, so their cells would be hypotheses rather than measurements.

Recommendation: option 2. Codex is the source we build from source and can measure; Cursor and Gemini stay on
Dev-13's deferral with the reason restated at the call site so the next reader does not re-open it blind.

### [host] Should an operator be able to supply the model price table this app costs sessions against?

*(denominator slice M#0)*

*Closes ledger cell **M9** (pi `absent`, claude `absent`, codex `absent`). Unblocks the "managed" value of
**M10**'s price-basis label, which is otherwise buildable as list/unknown only.*

**ANSWERED AND DELIVERED — this heading is kept for the record, not as an open question (re-verified
2026-09-11).** The owner took **A** as decision D11 on 2026-09-05 and P6.537 (`c40a8f736`) built it
host-side for all three runtimes:
`packages/shared/src/config/managed-model-prices.ts` symbol `priceUsageWithManagedTable` is reached from
`packages/shared/src/agent/base-agent.ts` symbol `managedBudgetPriceUsd`, which every runtime inherits. The ledger cell reads pi `covered`, claude
`partial`, codex `covered` since then. What survives as open is one NARROWER trade, and the
re-measurement below is what opened it: whether to emit `modelPricing` to the claude child so its own
cost figures agree with the host's, at the price of an env flag that also strips an administrator's
model pins. The options as written are the record of how A was chosen.

`modelPricing` is documented on `settings-reference.md#modelpricing` and is **absent from the vendored bundle**
(`grep -aoF modelPricing sdk.mjs` → 0 at 0.3.233, controls `Cookie` → 5, `git-subdir` → 4), so the bundle lags
the contract and claude cannot be configured into it either. **That bundle reading is dated 2026-09-05 and the
SDK lift to `0.3.247` refuted it — re-measured 2026-09-11: `modelPricing` scores 10 in `sdk.mjs`, 2 in
`sdk.d.ts` and 28 in the native binary, counted with `grep -aoF` against negative control
`nessyNotARealSdkKey` → 0 on each artefact.** The bundle no longer lags, so the question stops being *can
claude be configured into it* and becomes *should we set it*. Neither option's text below changes; what
changes is that **A** now rests on a measured native mechanism on one runtime rather than on a documented
absence — and that mechanism is an ENV GATE, not a plain setting: the managed-settings policy context
reads `modelPricing` whole only when `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set, and that same flag
strips `model`, `fallbackModel`, `modelPicker` and `modelOverrides` from the ADMIN tiers and filters their
`env` block. So A is cheaper to reach than it was and carries a cost it did not have. Pi and codex have no price table of any kind;
codex reports tokens and never USD. The consequence is written in our own source: the vendored path's value
"is 0 on every result … `sessionCostUsd` never moves"
(`packages/shared/src/agent/backend/claude/event-adapter.ts` symbol `ClaudeEventAdapter`), and the sole repo occurrence of the
key is a comment at `packages/shared/src/config/managed-env.ts` symbol `NO_WITHHELD`. A gateway or BYO model the bundled table
cannot price therefore costs nothing, and any USD budget cap over it is inert.

- **A — a host-side managed price table read by all three runtimes** — buys: cost estimates and USD budget caps
  become real for gateway and BYO models on every runtime, one implementation, and the M10 label gains its
  "managed" value so an operator can see which table priced a request — costs: upkeep of a price list the
  operator must maintain, and a wrong entry silently produces a confidently wrong cost figure and a cap that
  fires at the wrong moment.
- **B — keep "Not reported" and cap in tokens** — buys: nothing is ever invented; the honesty surface we already
  ship (`usage.costUnavailable`, `usage.costPartial`) stays the whole answer, and token budgets are exact —
  costs: no USD ceiling can bite on a gateway model on any runtime, and the documented `modelPricing` clause
  stays unmet on the runtime whose documentation is our contract.

Recommendation: **A**, with the table operator-supplied and never bundled, and every priced figure carrying
M10's basis label so a managed price is visibly a managed price.
Parity direction: **A** closes the difference — it is the only option under which all three runtimes can price
the same session identically. **B** leaves all three equally unable, which is uniform but leaves the cap inert.

### [host] Should the configuration checkup be allowed to change anything after you confirm, or stay a report?

*(denominator slice M#0)*

*Closes ledger cell **M14** (pi `absent`, claude `absent`, codex `absent`). The read-only half is delivered
(M15, `e40c1dedd`) and its desktop reach is already tracked by P6.168.*

`debug-your-config.md` draws a line our CLI quotes back at itself: `apps/cli/src/doctor.ts:20-23` states the
CLI form "never repairs anything, which is the difference `debug-your-config.md:44` draws", and `:2`/`:70`
record it as "the read-only configuration checkup", "read-only and session-free". The fixing half was
recorded as a deliberate non-implementation:
`docs/superpowers/plans/2026-07-29-doctor-surface.md:216-218` ("the fixing half is a different product from a
read-only report") and `:260-271` (Deviation 1, `documented, not implemented`, "Cost: 1 small slice"). No
runtime supplies the fixing half either: claude's own `/doctor` is inside the closed binary and unreachable
through the SDK query surface, codex has no config command at `rust-v0.148.0`, and `/checkup` has no parser
row (`packages/shared/src/slash-commands/help.ts` symbol `HELP_COMMAND_LABEL`, 21 entries, no `doctor`/`config`/`debug`).

- **A — stay read-only, and say so in the CLI help and the in-app view** — buys: zero new mutation surface, the
  existing invariant and its tests hold, and one sentence closes the expectation gap — costs: the page's
  propose-and-apply clause stays unmet, and every finding the checkup makes still has to be fixed by hand.
- **B — propose and apply after explicit confirmation, scoped to the two safe finding classes** (a derivable
  `CLAUDE.md` trim and a slow-hook fix) — buys: the documented behaviour on the two findings where the fix is
  mechanical and reversible, one host implementation serving all three runtimes — costs: the checkup becomes a
  thing that edits the user's files; every apply needs a diff preview, an undo and its own tests, and the
  blast radius of a wrong trim is the model's instructions.
- **C — B, plus removing unused skills, MCP servers and plugins** — buys: the page's clause in full — costs: the
  destructive half, where "unused" is a heuristic over surfaces the user may have installed for next week.

Recommendation: **B**, exactly as the sweep sized it — derivable-`CLAUDE.md` and slow-hook findings only, each
behind a diff preview and a confirmation, with removal left out until asked for by name.
Parity direction: all three options are uniform across runtimes (the checkup is host-side), so this is a
product-posture question and not a parity one; **B** closes the difference against the documented product.

### [host] May host telemetry name a person and a session?

*(denominator slice M#0)*

*Closes ledger cell **M33** (pi `absent`, claude `absent`, codex `partial`). Also gates the correlation-id
rider on **M31**.*

Both runtime children implement the page's standard-attribute table — binary probe
`OTEL_METRICS_INCLUDE_SESSION_ID` → 6, control 0; for codex the vendor's `[otel]` block carries the switch and
we pin it off. On all three the mechanism EXISTS and this fork withholds it, deliberately and in writing:
`packages/shared/src/telemetry/usage-metrics.ts:31-52` — "This fork exports NEITHER, nor any other row of that
table … no per-user or per-session identifier leaves the operator's machine … This fork implements none of
those flags" — and the Pi event stream carries only HMAC-SHA256 digests under a locally generated salt
(`packages/server-core/src/pi-harness/otlp-telemetry.ts:29-38`, `:205-212`). Not ruled in the plan's owner
sections nor in the out-of-scope register.

- **A — counts only; keep the current deviation and document it as the product's position** — buys: nothing
  personal ever leaves the machine, the existing HMAC design stays coherent, and no new consent surface is
  needed — costs: an operator cannot build the per-user audit trail the page describes, so tool calls and MCP
  activity stay unattributable; the deviation stays permanent on all three runtimes.
- **B — identity behind the documented toggles, default off** — buys: `enduser.id`/`session.id` and the rest
  arrive only where an administrator turned them on, using the vendors' own switch names on claude and codex
  and one host implementation for Pi; parity with both runtime children — costs: a real per-user identifier
  can leave the machine once enabled, so the toggle needs a visible statement to the user whose session it
  names, and the Pi HMAC scheme gains a second, non-anonymous mode.
- **C — full parity including content** — buys: everything the page offers — costs: this is the M34 question
  below, and answering it here would decide it silently.

Recommendation: **B** — and it is already the recorded recommendation:
`docs/superpowers/plans/2026-07-29-observability-and-cost.md:183` says "the toggles, not a default", `:185` for
the five `OTEL_LOG_*` channels. Add M31's per-turn OPAQUE id under either A or B, since it names nobody.
Parity direction: **B** closes the difference — it is the only option that makes Pi, claude and codex export
the same attribute set. **A** keeps them uniformly silent, which is honest but leaves codex's own pinned-off
switch as a capability the product refuses on the user's behalf.

### [host] May an ambient shell variable make a session export its whole conversation?

*(denominator slice M#0)*

*Closes ledger cell **M34** (pi `absent`, claude `have`, codex `absent`).*

One variable name, three answers. All four content opt-ins live in the shipped claude binary
(`OTEL_LOG_USER_PROMPTS` 8, `OTEL_LOG_TOOL_DETAILS` 6, `OTEL_LOG_TOOL_CONTENT` 6, `OTEL_LOG_RAW_API_BODIES` 5,
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` 3, control 0) and reach the child unfiltered, because
`buildClaudeSubprocessEnv` spreads `process.env` (`packages/shared/src/agent/options.ts:250`) — so an ambient
`OTEL_LOG_RAW_API_BODIES=1` exports the whole conversation today, with no host decision anywhere. Codex is
pinned the other way: `log_user_prompt = false` is written unconditionally
(`packages/codex-responses-adapter/src/config-writer.ts:2506-2522`, `:2595`). Pi and the host have no reader at
all (`otlp-telemetry.ts:39-42`, `usage-metrics.ts:44-51`). The claude cell reads `have` on the vendor's binary
plus the page — that verdict survives; the question is whether the fork keeps it.

- **A — strip the four `OTEL_LOG_*` opt-ins from the claude child and keep codex pinned off** — buys: uniform
  silence on all three runtimes, no conversation content leaves the machine on an inherited variable, and the
  divergence a switch would otherwise carry disappears — costs: an operator who legitimately wants content in
  their own collector cannot have it on any runtime, and we remove a working vendor capability.
- **B — honour them on all three behind one host setting** — buys: parity, the documented behaviour, and one
  place where the decision is visible and auditable instead of an inherited environment — costs: conversation
  content, including raw API bodies, leaves the machine; the host must also implement the cap
  (`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`) on the two runtimes that have none.

Recommendation: **A**, on the owner's own recorded pattern: where a capability exists on one runtime only,
removal or refusal has been chosen every time (plan lines 43-45). If content export is wanted later, it should
arrive as B's explicit host setting and never as an inherited variable.
Parity direction: **B** closes the difference upward, **A** closes it downward. Both are uniform; only the
status quo is not.

### [host] May a desktop app open a metrics scrape socket?

*(denominator slice M#0)*

*Closes ledger cell **M40** (pi `absent`, claude `absent`, codex `absent`).*

Host-side exporter, so tier 2: one implementation serves all three, and no runtime supplies it — the codex
binary's `[otel]` writer emits the log signal only. At HEAD `prometheus` scores 0
(`packages/shared/src/telemetry/usage-metrics.ts:556-574` builds an OTLP `resourceMetrics` payload and nothing
else) and the selector is read only as a hard disable (`:462` `otelExporterDisabled(env,'OTEL_METRICS_EXPORTER')`,
docblock `:14-15` "Honored as a hard disable, opt-in or not"). The split is already recorded by cost:
`docs/superpowers/plans/2026-07-29-observability-and-cost.md:186` — "Ours is otlp-or-nothing … A console
exporter is cheap; a Prometheus scrape endpoint is a listening socket in a desktop app and wants its own
decision."

- **A — implement `console`, refuse `prometheus` by name** — buys: the debugging half at near-zero cost, no
  inbound socket on any user's machine, and a named refusal so an operator learns why instead of meeting
  silence — costs: the page's `prometheus` value stays unmet, and a Prometheus-only shop gets nothing.
- **B — add the listening scrape endpoint too** — buys: full parity with the documented selector — costs: an
  inbound listening port on every machine that enables it, with its own bind-failure, port-collision and
  exposure story in a desktop app.

Recommendation: **A**, with **B** on demand — the same split the record already made.
Parity direction: both options are uniform across the three runtimes because the exporter is ours; **B** is the
one that closes the difference against the documented selector.

Note on scope: the `console` value in this question is the HOST exporter's own output and is distinct from
denominator **M21**, which is the opposite direction — refusing a `console` exporter to the claude CHILD,
whose stdout is our message transport. M21 needs no owner input and is written as a tracker row.

### [host] Let a hook or a Bash command post a message into its OWN session?

*(denominator slice N#0)*

Closes ledger **N10** (proposed) — `[pi]` `[claude]` `[codex]`, all three `absent`, delivered once by the host.

Today a script the agent launched has no way back into the turn that launched it. The page documents a per-session
inbox socket for this; the vendored bundle does not export it — `CLAUDE_CODE_MESSAGING_SOCKET` scores 0 on both
0.3.223 and 0.3.233, against live controls `disallowedTools` 45 and `bypassPermissions` 157 on the same binary —
so there is nothing to inherit, and codex has no equivalent. **REFUTED 2026-09-11 by the lift to `0.3.247`:
`CLAUDE_CODE_MESSAGING_SOCKET` scores 17 in the native binary and `CLAUDE_CODE_MESSAGING_TOKEN` 12, both
still 0 in `sdk.d.ts` and 0 in `sdk.mjs`** (`grep -aoF`, negative control `nessyNotARealSdkKey` → 0 on
each), so the subsystem is in the artefact and almost entirely outside the declared types. What arrived is
not one variable but a whole native ingress — the env pair, a session registry keyed on the socket path, a
`udsInboxShape` and framed `notify_when_idle` diagnostics (P7.17). There is now something to inherit, and
the question below is therefore a live three-way choice rather than a choice between building and not
building; codex still has no equivalent. Our sessions live inside ONE host process reached by
RPC, so the natural host mechanism is an RPC endpoint, not a Unix socket per session. The admission entry point
already exists: `SessionManager.admitAgentMessage` (`packages/server-core/src/sessions/SessionManager.ts` symbol `admitAgentMessage`).
The whole question is a posture, not a mechanism: this is a NEW authority boundary — an inbound path into a live
session's turn from an unprivileged local process.

- **(a) No new local IPC surface** — buys: zero new authority boundary, no token to leak, nothing new to audit —
  costs: the documented hook→session feedback path entirely; a long-running script can still only report by
  exiting, so anything it learns mid-run is lost.
- **(b) An RPC endpoint on the EXISTING session token, own-child only, routed through `admitAgentMessage`** so
  N2's accept/hold/refuse ladder applies unchanged — buys: the capability inside a boundary we already audit, with
  the loop, rate and size guards of P6.45/P6.46 already in front of it — costs: one new authenticated endpoint and
  its own-child check, which is the part that must not be got wrong.
- **(c) A per-session Unix socket mirroring the page's spelling** — buys: literal fidelity to the documented shape,
  so a hook written for Claude Code works unchanged — costs: a second transport beside our RPC, a socket path and
  token on disk per session, and a lifecycle to clean up on crash — for a variable the runtime we vendor does not
  actually export. **That last clause is dead as of 0.3.247 — the variable IS exported now (see the
  refutation above), so (c)'s cost is no longer "fidelity to a shape nothing implements".** Its cost is
  that the binary's own refusal text scopes the ingress to Claude sessions, so mirroring the spelling buys
  back a claude-only divergence on a host rung that is one choke point for three runtimes. A different
  cost, not a smaller one — and the first time the share-vs-split rule's *"a split needs a MEASURED native
  mechanism"* is satisfied on this question.

**Recommendation: (b).** It is the smallest honest thing: no new transport, no new secret, and the existing
admission ladder is the audit surface. **Parity direction:** (b) closes the difference — all three runtimes gain
the capability at once from one host endpoint, so the switch verdict stays UNIFORM. (a) leaves the gap open but
leaves it HONEST only if the capability descriptor says so. (c) closes it and buys a divergence back, because the
socket exists on our sessions and on nothing the runtimes themselves provide.

**Evidence:** `git grep -anI 'CLAUDE_CODE_MESSAGING_SOCKET\|CLAUDE_CODE_MESSAGING_TOKEN' -- ':(glob)packages/**'
':(glob)apps/**'` → exactly ONE hit, and it is a COMMENT recording the absence:
`packages/server-core/src/sessions/cross-session-inbound.ts:43`. Re-run 2026-09-11 the same probe answers
THREE hits, all in that one file and all still comment: the block now records the reversal beneath the
sentence cited here, which is the artefact a reader of this question should open first. Plan row P6.45's own native-first probe drove the
vendored bundle with the controls quoted above. Source page: `cross-session-messaging`.

---

### [host] Build host-relayed cross-machine session messaging, or say same-machine only in writing?

*(denominator slice N#0)*

Closes ledger **N11** (proposed) — `[pi]` `[claude]` `[codex]`, all three `absent`, one host decision.

The page advertises reaching one of your sessions on another machine, or on Claude Code on the web, addressed by
name like a local session. Its own route needs a claude.ai sign-in plus Remote Control, and the page **excludes
our case explicitly** (`cross-session-messaging.md:333`); codex has no session-to-session tool at all; there is no
Remote Control client anywhere in this tree. We own a server, so a relay is buildable — but nothing is native to
adopt, and this changes **what leaves the machine**, which is section C's own subject.

- **(a) No — same-machine only, said plainly in the capability descriptor and the switch report** — buys: zero new
  egress path, no new credential surface, and an honest divergence instead of a silent one — costs: the
  cross-machine coordination the page advertises, on all three runtimes.
- **(b) Relay via our gateway, with approval on** — buys: parity with the page as written — costs: a new egress
  path carrying session TEXT (not just tokens), plus an account dimension `sessionId` does not carry today, so the
  addressing scheme itself has to grow before the relay can exist.

**Recommendation: (a)**, consistent with section C's posture. **Parity direction:** (a) does NOT close the
difference against the page — it makes the residue HONEST, which is the host's job when the answer is "we
decline"; it is only a closed row if the descriptor and the switch report actually name it, so (a) carries a
`BUILDABLE S` surface obligation with it. (b) is the option that closes the difference, and it should not be taken
on this row alone — it is a section C decision wearing a section N hat.

**Evidence:** `packages/session-tools-core/src/handlers/send-agent-message.ts:5-8` — args are `{ sessionId,
message }`, with **no machine or account dimension** (verified at HEAD `34be43fde`). Delivery resolves the target
inside the sender's own Workspace and throws otherwise:
`packages/server-core/src/sessions/SessionManager.ts` symbol `deliverAgentMessage`, verbatim *"a target session ID resolves only
inside the sending session's Workspace"*. Source page: `cross-session-messaging`.

---

## Claude

### [claude] Should a claude session that ships our own agent definitions still expose the SDK's built-in `general-purpose` agent?

*(denominator slice H#0)*

Closes denominator **H32** [claude] — `absent`; pi and codex are `n/a` (our four built-ins are the whole set
on Pi; on codex a role is guidance and spawning is authorized independently,
`packages/shared/src/agent/runtime-agent-support.ts:52-56`). Size S.

Native mechanism, asked and found: the off-switch is the SDK's own env var, ours to set. Reproduced —
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` is in the shipped bundle (2 hits across
`node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs` and `sdk.mjs`) and scores 0 files across
`packages` + `apps`; positive control `disableAllHooks` → 2 on the same run. Today's behaviour is
DELIBERATE and written down at `packages/shared/src/agent/claude-runtime-agents.ts:885-888`, verbatim:
*"an empty record is omitted ENTIRELY rather than sent as `agents: {}`, so a session with no definitions
keeps the SDK's own built-in set (`general-purpose`, `Explore`, `Plan`, …) exactly as the runtime ships it"*.
Page `agent-sdk/subagents.md` line 172. Already triaged **TAKE** at
`docs/superpowers/specs/2026-08-28-claude-sweep-triage.md:461-471` — an engineering verdict, not an owner
ruling, which is why it is asked here.

- **A — keep it: a session with our definitions still carries the SDK's built-ins** — buys: a fallback agent always exists, and nothing changes for a session that ships no definitions of its own — costs: `general-purpose` is an unvetted agent with the full tool surface, reachable on a claude session and on no other runtime; none of our disallowed-tools, compatibility or budget checks were applied to it.
- **B — set the env var when we supply definitions, leaving only ours** — buys: the agent roster on a claude session becomes the roster the user configured, identical in kind to Pi's four; every reachable agent has passed our checks — costs: a session whose definitions are thin loses the SDK's fallbacks, and the built-ins' own capabilities (Explore/Plan) go with them unless we re-declare equivalents.

Recommendation: **B**, gated on our definitions actually being present — the condition the code already
computes at `:885-888`. Denominator H31's row supplies the same env plumbing for the Explore/Plan pair, so
the two land together.

Parity direction: **B** closes the difference — Pi and codex expose only vetted, user-visible agents, and B
makes claude match. **A** keeps claude the only runtime with an unvetted full-tool agent nobody declared.

### [claude] May a claude session reach MCP servers the app never configured?

*(denominator slice J#0)*

**Closes ledger cell:** J17 (pi `n/a`, claude `absent`, codex `unknown`). Not on the sitting page. Adjacent, not the same: P6.72 ⬜ measures whether a MANAGED denial stops the spawn; this decides whether the CLI's OWN discovery runs beside the servers we hand it.

Native mechanism: **claude has the exact knob and we deliberately leave it unset.** `Options.strictMcpConfig` (page `agent-sdk/typescript` §Options, `strictMcpConfig` row). The reasoning is recorded verbatim in our own code at `packages/shared/src/agent/claude-agent.ts` (grep the quoted sentence): "`strictMcpConfig` is not set on this path, so the CLI still performs its own MCP config discovery beside the servers we hand it. Anything it connects to that way is a REAL server" — and `onElicitation` is wired at `:4906` precisely because of it. On Pi every server is a host-owned in-process proxy, so the question does not arise; the codex arm was not measured here. The existing partial ruling `docs/architecture/managed-mcp-access.md:203` records this as `inapplicable`, and **that verdict rests on a premise `packages/shared/src/agent/claude-agent.ts` contradicts.**

**Question.** Should a claude session's reachable MCP servers be exactly the set the app configured?

- **Set `strictMcpConfig: true`** — buys: the set of servers a session can reach is exactly what the app configured, which is what the managed-MCP policy already claims to guarantee; the `managed-mcp-access.md:203` `inapplicable` becomes true rather than needing a correction. — costs: a user's own `~/.claude.json` servers stop working on the claude runtime and only there, so a working setup breaks on a switch; the elicitation wiring built for CLI-discovered servers becomes dead code.
- **Leave it unset and REPORT what the CLI discovered** — buys: honesty at the seam this fork's rules prefer — the user and the operator see which servers were connected outside our configuration, and the `:203` ruling is corrected rather than left false; nothing a user has working breaks. — costs: a report is not a control; an unconfigured server still reaches the model, so a managed denial remains bypassable on claude and the guarantee stays weaker than the Pi one.
- **Leave it exactly as it is and correct `managed-mcp-access.md:203`** — buys: zero behaviour change and zero risk; the documentation stops asserting something the code contradicts. — costs: the divergence stays SILENT to everyone who does not read that architecture page, which is the defect class this whole programme exists to close.

Recommendation: **option 2** — report, and fix `:203` in the same commit. It is the only option that neither breaks a working user setup nor leaves a false guarantee standing, and it is a precondition for option 1 anyway: you cannot judge whether strict mode costs anyone anything until you can see what the CLI is connecting to.

*Parity direction:* option 1 closes the difference against Pi (where the set IS exactly what we configured); option 2 makes it HONEST without closing it; option 3 closes nothing and is included only because it is the cheapest true statement.

---

### [claude] Tool search through our own loopback adapter — leave it off, teach the adapter, or honour the choice only where it can work?

*(denominator slice J#0)*

**Closes ledger cell:** J26 (pi `have`, claude `absent`, codex `absent`) — **claude arm only.** The codex arm is already before the owner at `2026-09-05-ledger-closure-owner-questions.md#codex-deferred-mcp-tool-loading-on-codex-when-the-only-live-route-is-a-hand-authored-catalogue`, whose recommendation is to decline and record the null; do not re-answer it here.

Native mechanism: **claude has the knob and we write only its OFF value.** `packages/shared/src/agent/options.ts` (`applyToolSearchOffSwitch`) is the ONLY write and it is `= 'false'`; `true`, `auto` and `auto:N` all leave `ENABLE_TOOL_SEARCH` unset, pinned by `claude-tool-search-off-switch.test.ts:102-107` (`true`/`auto`/`auto:5` → `undefined`). The reason is in the page, which for claude IS the contract — `agent-sdk/tool-search.md`, verbatim: "The SDK also disables tool search when `ANTHROPIC_BASE_URL` points to a non-first-party host, since most proxies don't forward `tool_reference` blocks. You can override that default with the `ENABLE_TOOL_SEARCH` environment variable." Our gateway loopback IS a non-first-party host. The per-runtime disposition report already exists at `packages/shared/src/agent/options.ts` symbol `describeToolSearchAcrossRuntimes`.

**Gating measurement, already a row:** P6.141 ⬜ "measure: does `ENABLE_TOOL_SEARCH=true` survive our own loopback, or only the gateway card fails it". **Answer this question after that reading, not before** — option 2's price is unknowable until it lands.

**Question.** Do we send the tool-search beta through our loopback adapter, and what happens when an operator sets `true` or `auto:N` today?

- **Leave it off — today's shape** — buys: zero risk of silent tool-definition loss, one behaviour on every non-first-party base URL, and the vendor's own default reasoning is respected. — costs: every MCP definition loads upfront on claude for gateway and BYO connections alike, so an operator with a large source set cannot reclaim that context on this runtime; and an operator's `auto:5` is silently ignored, which is a control that has stopped controlling.
- **Set `auto:N` and teach the loopback adapter `tool_reference` blocks** — buys: closes ledger J2/Claude — claude gains the deferral Pi already has, on every connection including the gateway card. — costs: the adapter must implement a beta block shape end to end; a proxy that mishandles it drops tool definitions SILENTLY, which is exactly the failure the SDK's default exists to prevent; and the beta shape can change under us with no version we control.
- **Honour the operator's choice only where the base URL IS first-party (a real Anthropic / Bedrock / Vertex BYO connection) and keep the forced OFF on the loopback** — buys: the operator's `true`/`auto:N` stops being silently ignored on the one path that can serve it, at no adapter work and no risk to the gateway card; the smallest honest thing. — costs: two behaviours by connection kind on one runtime, which must be named in the disposition report or it becomes a new silent divergence.

Recommendation: **option 3 now, option 2 only if P6.141 shows the loopback survives.** Option 3 costs a predicate and a report line and removes a dead control; option 2 is real parity but buys it with a silent-failure mode on the default connection, and its price is currently a guess.

*Parity direction:* option 2 closes the difference against Pi outright; option 3 closes it for BYO first-party connections and leaves the gateway card open but REPORTED; option 1 leaves it open and currently unreported — the report itself is P6.145 ⬜, which must land under any option.

---

### [claude] PowerShell as a first-class tool — enable it, refuse it, or leave it half-reachable?

*(denominator slice J#0)*

**Closes ledger cell:** J31 (pi `absent`, claude `partial`, codex `absent`). Not on the sitting page. The PowerShell mentions among unfinished rows (P2.75, P6.61, P6.66) are all permission-RULE rows; none of them enables or refuses the tool.

Native mechanism: **claude has it in the shipped binary and the enabling variable already reaches the child.** Binary probe on the vendored 2.1.233 SDK: `CLAUDE_CODE_USE_POWERSHELL_TOOL` → 13, and `PowerShell` → 1 in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`; `buildClaudeSubprocessEnv` spreads `process.env` wholesale (`packages/shared/src/agent/options.ts:250`), so **an operator who exports that name today switches the tool on and we neither know nor gate it.** The permission-rule half already exists — `packages/shared/src/agent/pi-harness/claude-powershell-rule.ts`, with a `powershell` matcher case in the DSL at `permission-dsl.ts:1130` — and hooks can already request PowerShell (`packages/server-core/src/pi-harness/plugin-hook-command.ts`). The two missing halves are `defaultShell` (0 files over tracked `*.ts`/`*.tsx`, control 228) and skill-frontmatter `shell:`. Pi would need a second shell executor; codex has no PowerShell tool in `packages/codex-protocol/generated/v2/`. Page: `tools-reference`.

**Question.** This is a product question with a measured safety consequence: a `Bash`-only deny rule does not cover PowerShell, and an operator can switch the tool on by environment variable without our rule surface following. Do we enable it, refuse it, or leave it as it is?

- **Leave it as it is** — buys: nothing to build. — costs: the status quo is the worst of the three — the tool is reachable by an environment variable we forward and not covered by the deny surface we advertise, so a `Bash`-scoped denial silently does not bind. This is a control that has stopped controlling, which the standing rules treat as in scope by definition.
- **Refuse it by name: strip `CLAUDE_CODE_USE_POWERSHELL_TOOL` in `buildClaudeSubprocessEnv` and say so** — buys: closes the hole in one predicate; the deny surface's promise becomes true again; transparent, because the strip is visible in the settings copy and in the switch report. — costs: we override an operator's own environment on the runtime we vendor, and a Windows operator loses a first-class tool the binary already ships. (Precedent exists: `options.ts` already forces `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.)
- **Enable it properly: honour the variable, extend the deny surface to the `powershell` matcher, and add `defaultShell` plus skill-frontmatter `shell:`** — buys: the documented capability on the runtime that has it, with the permission floor actually covering it; the `defaultShell` half is already a buildable row (J39). — costs: a second executor inside the permission floor to keep correct forever; and Pi and codex still have no PowerShell, so enabling it CREATES a switch divergence that must then be reported.

Recommendation: **option 2 now; option 3 only if Windows is a supported deployment for this product.** The safety hole is real today and closable in one predicate; building the second executor is a real cost that should follow a decision about Windows, not precede it.

*Parity direction:* option 3 closes the difference against the documented claude surface and OPENS one against Pi and codex. Option 2 closes nothing and makes the absence uniform and honest — which, for a capability no one has asked for on two of three runtimes, is the better-shaped answer.

---

## Codex

### [codex] What should an unattended codex turn do with a call no rule covers?

*(denominator slice A#0)*

*(Denominator A26 — pi `have`, claude `have`, codex `partial`; size M.)*

The correction first: the floor is already closed on codex. `codex-agent.ts:4154-4162` REFUSES when a
floor matches (`Refused with no user present: the … floor is non-negotiable`) and only auto-approves at
`:4162` when **no** floor matches. Pi and claude are fail-closed (`pi-agent.ts:6706`,
`packages/shared/src/agent/claude-agent.ts` symbol `CAN_USE_TOOL_NO_SURFACE_DENIAL`). So the open case is the no-rule call, on one
runtime, with nobody there to ask.

Codex has an unused native mechanism for exactly this: `AskForApproval` in `config-schema.json` — `never`
("Never ask the user to approve commands") and the granular variant whose false fields are "automatically
rejected instead of shown to the user".

- **A. Deny, as Pi and claude already do** — buys: one fail-closed behaviour across all three, and the
  switch report loses a SILENT-LOOSER row — costs: unattended codex jobs stall at the first uncovered
  call, so a scheduled run that used to finish now fails.
- **B. Keep auto-approving and pay the honesty instead** — buys: unattended jobs keep completing, nothing
  to re-verify — costs: on one runtime the ABSENCE of a human widens what runs, which is the worst
  direction for a default; a documented divergence is copy, not protection.
- **C. Operator setting defaulting to deny, wired to codex's own `AskForApproval` granular rejection** —
  buys: native-first (the mechanism exists and we simply never write it), the deployment chooses, and the
  default is the safe one — costs: one more managed key to keep true and to score for enforcement.

**Recommendation:** A as the behaviour plus C as the escape hatch. The native-first rule points here: the
runtime already has the switch, we have never written it, and a build proposal must say so.

**Closes the difference:** A — and C at its default — closes it; B converts a silent widening into an
honest one, which is the host's job but is not parity.

### [codex] "Approve for me": a selectable mode, a codex-only setting, or folded into `auto`

*(denominator slice A#1)*

**Closes:** Denominator A65 — pi `absent`, claude `absent`, codex `partial`.

*Not the same question as* `2026-09-05-ledger-closure-owner-questions.md#[codex] Codex ships its own
model-backed approval reviewer, we already wired it, and it is default-OFF` — that one asks whether the
reviewer is ON by default. This one asks **what the user selects to get it**. The mechanism itself is
landed (plan line 22): `approvals_reviewer = "auto_review"` plus optional `[auto_review].policy`,
setting-gated, emitted only when the resolved policy is interactive. What is absent is a *mode* — today
the behaviour rides an unrelated setting, so a user who wants "keep the workspace boundary, but send the
crossings to an automatic reviewer instead of to me" cannot ask for it by name.

- **A — a codex-only setting, named in the settings page and in the switch report** — buys: smallest
  change, no new entry in the permission-mode control, no promise on runtimes that cannot keep it. —
  costs: the capability stays invisible where users choose their safety posture; the mode picker keeps
  claiming to be the place safety is decided while a second place also decides it.
- **B — a mode on all three runtimes, `absent-with-reason` on Pi and claude** — buys: the user meets it
  where they already choose a posture; the switch report can say, in one sentence, what selecting it
  costs on the other two; it is the only option that makes the difference legible at the switch. —
  costs: an eighth mode in a control the owner has already been asked to simplify (see the seven-modes
  question below), and two runtimes where selecting it degrades to something else.
- **C — fold it into `auto`** — buys: no new surface at all; `auto` already means "do not ask me", so
  routing the crossings to codex's reviewer is a strict improvement inside a mode that exists. — costs:
  `auto` then means different things per runtime, which is the exact divergence class this plan exists
  to remove; and the reviewer's emit gate requires an interactive policy, so `auto` would have to stop
  resolving to `never` on codex — a behaviour change smuggled inside a naming decision.

**Recommendation:** **B** — but sequenced after the default-ON/OFF question above, because a mode nobody
can reach by default is worth less than an honest setting. If that question answers **A** (stay opt-in),
take **A** here too and revisit.

**Parity direction.** **B closes the difference** — it is the only option that puts the capability in the
same control on every runtime and forces the two absences to be stated. **A and C leave it a codex
secret** (C additionally makes an existing mode diverge).

**Evidence:** `packages/codex-responses-adapter/src/config-writer.ts:313-330` (setting-gated, default off,
emitted only when the resolved policy is interactive), `:655-663` (`CodexApprovalsReviewer =
'auto_review'`, legacy `guardian_subagent` never emitted), `:2623` (`emitAutoReview = … &&
approvalPolicy !== 'never'`); `packages/shared/src/agent/codex-config-requirements.ts:370` classifies
`autoReview` as codex-enforced; plan line 22 (mechanism taken), P3.2 `384e2fb38`+`7736e32a9`.

### [codex] Seven fused permission modes, or codex's own two axes and its named profiles

*(denominator slice A#1)*

**Closes:** Denominator A67 (pi `absent`, claude `absent`, codex `absent`) and A68 (pi `n/a`, claude
`n/a`, codex `absent`) — one posture decides both.

Codex's own configuration keeps **sandbox** and **approvals** as two independent keys (`sandbox_mode`,
`approval_policy`) and supports **named permission profiles** (`[permissions.<name>]`,
`allowed_permission_profiles`, `default_permissions`). We fuse the two axes into seven named modes — one
frozen pair per mode, four of the seven emitting an identical pair — and we write exactly ONE profile,
`[permissions.nessy_runtime]`, derived from that table. So a user cannot change *who reviews* without
also changing *what the agent may touch*, and cannot select a profile at all.

- **A — keep the seven fused modes; spend the effort on making their descriptions true per runtime** —
  buys: one safety control with the same meaning on all three runtimes, which is the whole switch-safety
  argument; the known defect (ledger A11 — descriptions false on codex) is cheap to fix. — costs: two
  native capabilities stay unreachable; a codex-native user meets a smaller product than codex offers.
- **B — expose both axes, keep the seven as presets** — buys: the sandbox and the approvals can move
  independently on the runtime that supports it; presets keep the simple path simple. — costs:
  re-teaches the central safety control, and the two axes have no meaning on Pi or claude, so either the
  control is codex-only or two runtimes show a degraded version of the primary safety UI.
- **C — B, plus surface user-authored codex permission profiles** — buys: the full native model, and an
  operator can ship a profile per project. — costs: B's costs, plus "permission mode" then names
  different things per runtime — a user-authored profile has no Pi or claude twin at all, and the ADMIN
  requirement (ledger B5) already covers the operator case without a user-facing selector.

**Recommendation:** **A** for both — keep seven, fix the descriptions. The capability lost is real, but
the thing being protected is the one control a user reads before allowing a destructive action, and it is
the only control that must mean the same thing after a runtime switch.

**Parity direction.** **B and C close the difference with codex** (C fully), at the cost of *opening* a
difference between runtimes. **A does not close it; it declares it** — which under the native-first rule
is the host's job, but is not parity. Whichever is chosen owes a switch-cost sentence.

**Evidence:** `packages/codex-responses-adapter/src/config-writer.ts` symbol `CODEX_PERMISSION_MODE_TABLE`,
exactly seven frozen `{sandbox_mode, approval_policy}` pairs (dontAsk, explore, plan, default,
acceptEdits, auto, bypassPermissions), four emitting an identical pair; `:1311-1313` derives the sandbox
from the mode alone; `:2738-2741` emits `sandbox_mode` plus `default_permissions = "nessy_runtime"`;
`config-writer-permissions.ts:60`, `:746-793` builds that one profile; repo-wide
`allowed_permission_profiles`/`allowedPermissionProfiles` → 4 generated-protocol/schema files, one
comment (`codex-agent.ts:6126`), one classifier entry (`codex-config-requirements.ts:369`) — no writer,
no reader. Pages `permission-modes` (refuted line refute_codex_3, row 89), `learn.chatgpt.com` sandboxing
row 101 (weak tier).

### [codex] An unbounded `**` deny-read glob: bound the scan, or keep the honest warning

*(denominator slice A#1)*

**Closes:** Denominator A69 — pi `n/a`, claude `n/a`, codex `partial`.

Codex refuses to expand an unbounded `**` deny-read glob past a match ceiling and degrades it to a
startup warning on Linux and Windows. It offers `glob_scan_max_depth`. We deliberately do NOT write it,
because writing it **silences the warning by capping the expansion** — the deny stops applying below the
cap while the config still claims it. Windows is an arm we ship.

- **A — leave it unset and keep the warning** — buys: the config never claims a deny it is not applying;
  the operator sees the warning and can narrow the pattern. — costs: on Linux and Windows an unbounded
  deny-read glob does not deny, and the only thing standing between the model and those paths is a
  message at startup.
- **B — write a bounded `glob_scan_max_depth` on the affected platforms** — buys: the deny applies within
  the depth, on the platforms where today it applies nowhere. — costs: it converts a loud partial failure
  into a silent partial success — below the cap the deny is real, above it the rule is quietly inert and
  nothing warns; that is a control that stops controlling, the class this plan treats as worst.

**Recommendation:** **A** — leave the warning. This tree measures 43 matches across all nine shipped
patterns against a ceiling of 8192, so the warning does not fire in our own configuration; the risk is an
operator's own broad pattern, and for that a loud failure beats a quiet cap. Revisit only with a
measurement of a real operator pattern that trips the ceiling.

**Parity direction.** **B closes the difference** with codex's own capability; **A keeps the honest
surface** and leaves the deny unenforced above the ceiling. Codex is the only runtime with a subject
here, so neither option changes a runtime-to-runtime difference.

**Evidence:** `packages/codex-responses-adapter/src/config-writer-permissions.ts:200-213` verified
verbatim ("deliberately NOT written … the one knob a reader will reach for", citing codex
`permissions.rs:370-378`), with the named cost of leaving it unset at `:209-213`
(`MAX_UNREADABLE_GLOB_MATCHES = 8192`, `bwrap.rs:56`, `:744-748`; this tree measures 43 matches across
all nine patterns). No owner ruling in the plan's decision sections or the out-of-scope register.

### [codex] May a codex connection use the operator's own AWS Bedrock account, and leave the Nestor gateway to do it?

*(denominator slice C#0)*

*(closes denominator **C15** — `amazon-bedrock`; Pi `have`, claude `have`, codex `absent`)*

Codex HAS it natively: `model_provider = "amazon-bedrock"` in `config.toml`, credentials from
`AWS_BEARER_TOKEN_BEDROCK` or the AWS SDK chain. Only our pin stands between them —
`packages/codex-responses-adapter/src/config-writer.ts:797-801` always writes our loopback as
`model_provider`. Pi reaches Bedrock at `packages/shared/src/agent/pi-agent.ts` symbol `buildAwsEnv`
(`piAuthProvider === 'amazon-bedrock'`, catalogue in `config/llm-connections.ts` +
`config/bedrock-model-ids.ts`); claude through
`packages/shared/src/config/claude-provider-routing-env.ts:54-60`. **Correction the answer turns on:**
`AWS_BEARER_TOKEN_BEDROCK` does NOT score 0 — P3.346 exists precisely because the boot reset must NOT
delete it (`packages/shared/src/config/__tests__/boot-auth-env-reset.test.ts:9,73`), and every
non-Claude child is built by spreading `process.env`
(`packages/codex-agent-server/src/runtime-manager.ts`), **so an ambient Bedrock credential already
reaches the codex child today** — the question is whether anything may act on it.

- **a. No — keep the loopback pin, and say so** — buys: preserves C5's guarantee that no ambient cloud credential can route a session away from the configured gateway, on the runtime where that guarantee is currently strongest — costs: the codex↔Pi/claude difference stays, and it stays for a capability the runtime already has; a Bedrock-only organisation cannot use codex at all.
- **b. An explicit BYO Bedrock card only — the connection declares it, the ambient chain never decides** — buys: closes the difference for the user who asks for it, through codex's own documented mechanism (native-first step 1), while an ambient `AWS_*` in someone's shell still cannot reroute a pinned session — costs: one more provider card, its catalogue and its credential surface; the card's existence is a disclosure an operator must be able to switch off.
- **c. Also honour the ambient AWS credential chain, as codex's own default does** — buys: works with an already-configured corporate AWS profile, no new card, no new credential surface — costs: it is exactly the reroute C5 was built to refuse, and it would land on the runtime whose child already inherits the variable, i.e. it ships silently.

Recommendation: **b**.

Parity direction: **b closes the Pi/claude↔codex difference under an explicit user act.** c closes it
implicitly and regresses C5. a keeps it and makes it honest.

### [codex] The service tier is a first-class codex wire field we send nowhere — user control, managed requirement, or an honest null?

*(denominator slice K#0)*

Closes **K26**. `service_tier` is first-class in codex's own config and on five of its thread/turn param types,
and we send it on none of them. On claude the only spelling is Bedrock-only and unreachable here; Pi has no tier
field on any card. Searched for a RECEIVING side and found none: the Nestor gateway's catalogue carries six
fields and no tier, and our codex upstream is the loopback adapter — so today nothing downstream would honour a
tier even if we sent one. The refutation that matters: we do NOT already honour an organisation's
`requirements.toml` tier — the parser reads it and renders a warning whose own text says the requirement is not
applied.

- **(a) Send codex's `serviceTier` on `thread/start` (and per turn), claude and Pi absent** — buys: the field the runtime declares actually travels; a user or operator can pick cost-vs-latency where the wire supports it. — costs: a deliberate one-runtime capability, so it owes a switch verdict on day one; and with no receiving upstream today it may be inert in our own deployment — a control that appears to control.
- **(b) Apply the MANAGED requirement, closing B5's `'client'` field** — buys: an administrator's `requirements.toml` tier stops being a warning and becomes an effect; it closes a named enforcement hole rather than adding a user knob; it is the smaller honest thing. — costs: it binds only on codex, so the same managed file means different things on different runtimes; and it needs the model resolution moved to after the requirement is read, which is the reason the warning exists.
- **(c) Nothing, plus an honest surface** — buys: no inert control; the divergence is named where the user meets it, which is what the seam rule asks for. — costs: a declared first-class field of a runtime we ship stays permanently unused, and an administrator's tier stays a warning.

Recommendation: **(b)**. It closes a measured enforcement hole (the `'client'` cell) rather than adding a knob
with no receiver, and it is the direction the parity difference actually points. Parity direction: (b) then (a) —
(a) alone widens the switch difference without closing the managed one.

Evidence: `packages/shared/src/agent/codex-config-requirements.ts:665-666` parses `newThread.serviceTier`,
`:454` types it, `:980-990` renders it into a WARNING whose own text is "this build resolves a model for every
codex thread before the requirement is read, so the requirement is NOT applied"; the enforcement table at `:288`
marks `models` `'client'`. `serviceTier` outside `generated/`+`schema/` is three files (that parser, its test,
`__tests__/codex-fork-thread-start-params.test.ts:34`); `git grep -al service_tier -- packages apps` -> 5 files,
all generated/schema. Types `packages/codex-protocol/generated/v2/Config.ts:23`,
`ThreadStartParams.ts:12`, `TurnStartParams.ts:29-31` (re-read at HEAD: `serviceTier?: string | null`, "Override
the service tier for this turn and subsequent turns"); source `codex-rs/config/src/config_toml.rs:362` at
`rust-v0.148.0` — strong tier. Pages `amazon-bedrock.md` (`ANTHROPIC_BEDROCK_SERVICE_TIER`, Bedrock-only),
`config-sample` (row 33).

### [codex] Codex's own `[features]` table has 124 keys and we write two

*(denominator slice L#0)*

Closes: **L18**. Verdicts: pi `n/a`, claude `n/a`, codex `partial`. Size M.

The mechanism is codex's own and we already open the file: `packages/codex-responses-adapter/src/config-writer.ts:2752`
writes `[features]` and exactly two keys — `multi_agent = true` (`:2753`) and `view_image = true` (`:2779`). Two more
were measured and deliberately refused with their reasons written at the site (`:2781-2812`: `tool_search`,
`codex_git_commit`), so the writer already knows how to decide. Nobody has decided for the stable user-facing ones:
hooks, apps, goals, fast mode, shell snapshot, unified exec, the remote plugin catalog. `packages/codex-protocol/schema/config-schema.json`
carries 124 keys under `properties/features` and another 124 under `definitions/ConfigProfile/properties/features`.

- **Leave the other 122 unwritten** — buys: no new posture, no maintenance surface, codex's own defaults govern.
  — costs: seven user-facing capabilities are on or off by a vendor default nobody in this fork has read, and a
  codex version bump can flip any of them silently; the fork cannot say what its own product does.
- **Write the stable user-facing subset explicitly, each with a stated reason at the site** — buys: the seven
  become ours, pinned by the config-writer test and immune to an upstream default flip; the two existing refusals
  become a pattern rather than an exception. — costs: a surface that must be re-diffed against 124 keys on every
  codex bump (P3.283 is already moving the tag), and each key needs a defended pole.
- **Write them AND expose them as settings** — buys: the user chooses per capability. — costs: seven settings rows
  with no counterpart on Pi or claude, which is a new silent divergence unless the switch report carries every one.

Recommendation: **option 2**. It matches the discipline already in the file, needs no new UI, and answers the
question the owner actually asked — what does the product do — without minting seven single-runtime settings.

Closes the difference: options 2 and 3 close it (our defaults, not the vendor's); option 1 leaves codex's behaviour
set by an unread default. Note: `features.codex_git_commit` is already tabled at sitting §1.7 / P2.11 and is
deliberately not re-asked here.

### [codex] A repository's checked-in `.codex/` layer, and codex's own trust model

*(denominator slice L#0)*

Closes: **L22**. Verdicts: pi `unknown`, claude `unknown`, codex `absent`. Size M.

Confirmed at the STRONG tier: `codex-rs/config/src/config_toml.rs:423` `pub projects: Option<HashMap<String, ProjectConfig>>`,
`:538` `pub trust_level`, `:542-547` `is_trusted()`/`is_untrusted()`, and `:743-747` a trust decision that also seeds
`sandbox_mode` — all at `rust-v0.148.0`. We write the per-session `mkdtemp` `CODEX_HOME` whole
(`packages/shared/src/agent/codex-agent.ts` symbol `createRuntime` — `mkdtempSync` + `chmodSync(0o700)` — and `cleanupRuntimeResources` removes it at teardown) and never write a trust entry, so no
project is ever trusted and the repo's own `.codex/` layer never loads. The host already knows the answer:
`this.config.projectTrusted` is read at `:2092`, `:2129`, `:4374`. `git grep -a trust_level -- packages apps` → 2 hits,
one vendored schema and one docblock (`codex-agent.ts:1605`), never written.

- **Keep every project untrusted and say so** — buys: a checked-in `.codex/config.toml`, hooks or command rules can
  never take effect from a repository the user merely opened. — costs: codex's own project layer is dead in this
  fork, and the user is never told; a team that ships `.codex/` sees it work in codex and not in Nessy.
- **Project the host's existing `projectTrusted` onto codex's `trust_level`** — buys: native-first — codex's own
  trust gate decides, one host notion drives it, and `is_untrusted()` keeps the repo layer out for untrusted
  projects. — costs: a trusted project's checked-in `.codex/` gains real effect, including config keys we do not
  audit, and codex's own rule seeds `sandbox_mode` from that same decision.
- **Project trust but load only a named subset of the repo layer** — buys: the useful half (instructions, command
  rules) without handing a repository the sandbox and provider keys. — costs: a divergence from codex's own
  semantics that we would have to describe, and a subset list that ages against 94 top-level properties.

Recommendation: **option 2**, because `projectTrusted` already exists and already gates comparable decisions — this
is exactly the native-first ordering — with the `sandbox_mode` consequence stated at the site, and with the
credential floor unchanged (sitting §3.1 already fixes the floor's precedence over `danger-full-access`).

Closes the difference: options 2 and 3 close it; option 1 keeps codex's project layer permanently inert and needs
the honest surface instead.

### [codex] Codex's bundled skill tree, which the host's off switch cannot reach

*(denominator slice L#0)*

Closes: **L56**. Verdicts: pi `n/a`, claude `n/a`, codex `absent`. Size S.

A cold managed `CODEX_HOME` comes back holding codex's re-extracted bundled `skills/` tree — 87 entries, measured on
the shipped `darwin-arm64` build (`codex-agent.ts:896`, 2026-09-03, two differing `installation_id`s as the positive
control) — and our developer instructions are placed ahead of codex's own `<skills_instructions>` (`:1177-1179`). The
host's switch exists with no codex projection: `packages/shared/src/config/bundled-skills-settings.ts`
(`disableBundledSkills` / `NESSY_DISABLE_BUNDLED_SKILLS`). Codex's own keys are in the vendored release schema
(`SkillsConfig`): `include_instructions`, `bundled.enabled` (`BundledSkillsConfig`), and `[[skills.config]]`
`path`/`name` + `enabled`. `bundled.enabled = false` is the exact analogue of our switch; none is written
(`git grep` for `[skills]`, `include_instructions`, `[[skills.config]]` outside `schema/`/`generated/` → 0 emit sites).

- **Project the host switch onto `bundled.enabled`** — buys: `disableBundledSkills` finally means the same thing on
  all three runtimes; native-first, one key, no host machinery. — costs: codex's own useful bundled skills go with it
  — including `$skill-installer`, which is the only skill-by-name installer in the product (L62) — so a user turning
  off OUR bundled skills silently loses codex's too.
- **Leave codex's tree on, and say so** — buys: codex keeps its own capabilities; one honest line at the switch. —
  costs: a documented off switch is half-true, which is the fork's largest defect class; the model sees 87 skills the
  host neither lists nor gates.
- **Project the switch AND surface codex's tree in the host skill list** — buys: one switch, one list, per-skill
  control through `[[skills.config]]`. — costs: 87 entries enter a host surface built for our own, and the list must
  survive a codex bump re-extracting a different tree.

Recommendation: **option 1** as the immediate honest move, with **option 3** as the finished shape once
`skills/list` is wired (the row composed for L60). Option 2 leaves a control that does not control.

Closes the difference: options 1 and 3 close it; option 2 closes it only in the honest-surface sense.

## Pi

*(none — no question in any slice carries this tag.)*

## Slices with no new question

### D#0

# Owner questions — denominator group D, slice 1 of 1 (entries D5–D7)

**No new owner question in this slice.** All three entries are `BUILDABLE S` in the denominator table and were
placed as tracker rows in `rows-D-0.md`: D5 and D6 together in one row (one file, one lane), D7 in its own.
Nothing here changes a product posture that is not already ruled or already asked.

### J#1

# Owner questions — denominator group J, in-scope entries 46–48 of 48 (slice 2 of 2)

Entries in this slice: **J57**, **J58**, **J59**. All three are `BUILDABLE` in the denominator table and
survived that classification at HEAD, so **this slice raises no new owner question**. Each entry lands as a
tracker row in `rows-J-1.md` §Rows.

*(none)*

Why each entry did not become one, so a later lane does not re-open it:

- **J57** — the only posture in the neighbourhood is already recorded in code and this row deliberately does
  not touch it: `packages/shared/src/agent/backend/internal/runtime-resolver.ts` symbol `resolveRipgrepPath` states
  *"Packaged apps must use vendored binary only — never resolve from PATH to avoid picking up an incompatible
  system install."* The row is scoped to observability (a Search-backend entry in
  `buildConfigDoctorReport`) plus the env wiring in the non-packaged case the resolver already permits, so
  nothing user-visible about the packaged product changes and there is nothing to decide. Should a later lane
  want the packaged app to accept a system `rg`, **that** is an owner question and it is not asked here.
- **J58** — a preference for where a downloaded file lands, defaulting to today's behaviour. No safety trade,
  no operator cost, no policy change; the existing handler already logs every download either way.
- **J59** — the execution path, the approval path and the operator kill switch all already exist
  (`disableSkillShellExecution`, `skills.md:638`); the row adds a user-invocable entry point on top of them
  and changes no posture.

### O#0

# Owner questions — denominator group O (Notifications, UI, accessibility), entries O7–O21

Slice 1 of 1. Three of the fifteen entries are OWNER; **all three are already asked or already ruled**, so this
file opens no new question. The remaining twelve are two promotions and nine tracker rows in
`rows-O-0.md`.

(none — every OWNER entry in this slice resolves to an existing question or an existing owner ruling; see below.
Writing a fourth option, or restating a question the owner already holds, is exactly what the closure brief
forbids.)

## Already asked

### A#0

- A20 [codex] — Turn the sandbox off and have it actually be off on codex → sitting §3.1
  (`docs/superpowers/specs/2026-09-04-owner-sitting.md` §3.1, two options, recommends (A)). Not
  restated. `honest_surface: present` — `CodexAgent.noteResolvedSandboxPolicy` already emits a durable
  operator notice naming which syntax is in force (commit `6b9216811` verified present); the mechanism is
  `resolve_permission_config_syntax` at `packages/codex-responses-adapter/src/config-writer.ts:2684-2742`,
  which sets `Legacy` from `sandbox_mode` then UNCONDITIONALLY sets `Profiles` from `default_permissions`,
  so our unconditional credential profile overrides the off switch.

### A#1

- A85 [claude] — **already ruled, no new question.** The three sandbox binary-path settings
  (`bwrapPath`, `socatPath`, the ripgrep path) are R50's `policyHelper` class — a managed key naming an
  executable the app runs — **DROPPED by the owner 2026-08-08**. No silence: the tolerant parser strips
  them with a named drop. See `packages/shared/src/config/managed-approval.ts` symbol
  `DOCUMENTED_UNCARRIED_SANDBOX_KEYS` (the page's "Sandbox binary settings" category quoted verbatim; the
  module header's §"Two kinds of emptiness" names the three binary keys a STANDING REFUSAL — "Add a name
  here only to record a DECIDED refusal" — distinct from `hook`/`instruction`, names held against a future
  carrier. This entry used to attribute a "provably empty category" sentence to a line range of that file
  beginning at its line 20; the module never contained it — corrected 2026-09-11 by W13-e, `c88321f4e`),
  same absence at
  `managed-composition.ts:122`, stripping pinned by `managed-approval.test.ts`. The nearest OPEN work is
  P6.73 (measure: does the vendored SDK spawn an administrator-placed `policyHelper`), which is the
  enforcement question, not this projection question.
- A86 [claude] — **already ruled, no new question.** The sandbox `credentials` family (files, env vars,
  `mask`/`injectHosts`, `extract`/`decode: jwt`/`maskClaims`, AWS pairs, SigV4) is **DEFERRED by the
  owner** in the 2026-08-22 decisions ledger (`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:18`):
  the sandbox is off by standing decision, the host deny-floor works, and the deviation is recorded.
  → **sitting §1.1** is the revisit trigger. One datum updates the record without changing the ruling:
  `2026-07-31-claude-coverage-map.md` row 106 says the 2.1.224 additions are absent from the bundle, and
  at SDK 0.3.233 they are PRESENT (`sdk.d.ts:2802` `maskClaims`, `:2804` `injectHosts`, `:2824`
  `allowPlaintextInject`, `:2825` `awsPairs`) — the version barrier that note relied on is gone.
  Out-of-scope register O26 carries the same family.

### B#0

- **B15** [pi][claude][codex] — Set environment variables under a settings file's `env` key and have them apply
  to every agent process, including the proxy/CA/mTLS variables and the empty-string escape hatch.
  → `docs/superpowers/specs/2026-09-04-owner-sitting.md` §1.2 (options (A) refuse permanently and disclose,
  (B) apply behind a name allowlist; controller recommends (A); the third shape — contain the file — is
  foreclosed by the 2026-08-12/13 standing decision). Open plan row: **P3.373** ⏸ (`216da994a`), which already
  carries the three premise corrections and the restored pin. Do not restate; the ADMIN half of the same key
  is ledger B4, `covered ᵗ` ×3.

### C#0

- **C18** [codex] — already RULED, not merely asked: Linux support is paused and the absence is guarded at build time — `apps/electron/scripts/build-linux.sh:300-310` (*"Linux ships no codex binary today (electron-builder.yml's linux includes are commented out while Linux support is paused)"*, then `codex-integrity.ts … --forbid-app-server` as the deliberate no-op leg) and `apps/electron/electron-builder.yml:244-262`. `honest_surface`: present at build time, unverified in-product. **No question until Linux resumes.**
- **C19** [claude][codex] — already RULED: `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` line 676 defines GATED in the owner's own words (keep it working, do not delete) and line 689 records that filing the subscription cards as OUT was the controller's error. The card exists and works behind `NESSY_FEATURE_PROVIDER_CLAUDE`, default-off; `packages/shared/src/feature-flags.ts` symbol `isAnthropicBackendEnabled` (= `isProviderEnabled('claude') \|\| isClaudeRuntimeEnabled()`).
- **C25** [claude][codex] — already RULED: plan lines 1127-1133 (owner decision 6) keep the asymmetry, and the subscription path that carries the exposure is default-off, so it is not shipped; P3.52 (`ab9a5ebdb`, plan line 3221). Ours never egresses (`packages/shared/src/agent/claude-context.ts:264-270`), the claude child's channels are suppressed by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (`packages/shared/src/agent/claude-agent.ts` symbol `startLocalAdapterRuntime`) and codex's are closed by an EMITTED `[analytics] enabled = false` (`config-writer.ts:2606-2607`, validated `:3202-3206`). **One owed condition recorded with the ruling:** does that flag also disable Remote Control on the gateway path? **Re-read 2026-09-24 (F1.581), a scope the sentence above does not state:** the flag is written on the `claude-runtime` loopback path only, the one every `claude-runtime` connection takes (the gateway card and BYO ones alike); every other provider type goes through the direct-auth branch (`resolveAuthEnvVars`), which does not set it, and a comment beside the `Monitor` entry of `CLAUDE_SESSION_DISALLOWED_TOOLS` says so in as many words. The subscription path is one of those, and it is the default-off path the ruling already rests on, so the ruling and its one owed condition stand.
- **C26** [codex] → `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md#[codex] Shell network egress on codex — deny legibly, open with the isolation switch, or allowlist domains?` — `permissions.<name>.network.allow_local_binding` is one key of the same `[permissions.nessy_runtime.network]` table that question decides, and the private-address exception only arises under its options **B** and **C**; under the recommended **A** it has no subject. (`git grep -ac allow_local_binding -- packages apps` → 2, both in the vendored `packages/codex-protocol/schema/config-schema.json`, 0 in code; `packages/codex-responses-adapter/src/config-writer-permissions.ts` writes the enclosing table and its `.filesystem` block.) A one-line widening of the intranet boundary must not be taken by a lane.
- **C29** [claude] → sitting §3.4 (`docs/superpowers/specs/2026-09-04-owner-sitting.md:372`, *"What 'Artifactory-latest' means for the Claude SDK pin"*; register O28 verified UNRULED verbatim). **Addendum the sitting section does not carry:** four surfaces on `agent-sdk/migration-guide` gate on patch numbers above our pin (`claude-agent-sdk` 0.3.233 / `claudeCodeVersion` 2.1.233) — entry `headers` at 2.1.238, `getContextUsage({detail})` at 0.3.257, `hooks_applied` at 0.3.238, per-server MCP `timeout` at 0.3.248 — so the answer decides whether `getContextUsage({detail})` is reachable at all. Page `#installation`: *"The SDK version tracks the bundled Claude Code version… a feature on this page that requires a Claude Code version needs the SDK release with the same patch number or later."*

### D#0

- **D5** — the posture behind `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is **already ruled, not open**:
  `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1127` — *"`DISABLE_NONESSENTIAL_TRAFFIC` — keep as is.
  Confirmed. `P3.52` closes as recorded-and-accepted"*, with one condition still owed at :1130-1132 (whether the flag
  disables Remote Control on the gateway path; "that check is not optional, it is the condition on the answer").
  The row carries that condition as evidence. The **adjacent** question that must not be conflated with it:
  → `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md#[claude] One telemetry opt-out, two meanings — do we override the runtime we vendor?`
  — that one is ledger **M1** (whether `DO_NOT_TRACK`/`DISABLE_TELEMETRY` should silence the SDK's OTLP export) and
  names `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (set in `packages/shared/src/agent/claude-agent.ts` symbol `startLocalAdapterRuntime`) only as the regression its option 2 must avoid. D5 is the *disclosure* of the flag we
  already set, which option 1 of that question explicitly leaves unpaid — a build, not a decision.
- **D6** — no owner question: codex ships `explorer` and `awaiter` already, nothing is enabled or turned off, and the
  deliverable is one sentence of switch-report copy. The adjacent codex agent questions are different subjects —
  `### [codex] Declare the bundled `reviewer` role on codex, or keep denying it?` (our role, not codex's) and
  `### [codex] Align the unset-case subagent ceilings, or leave codex's own?` (the `[agents]` numeric keys).
- **D7** — no owner question: reading an array the vendor publishes for exactly this purpose, with "ignore unknown
  values" as the vendor's own instruction, is the nearest documented solution and touches no user-visible policy.

### E#0

- (none — the 28 headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and the 20 of `docs/superpowers/specs/2026-09-04-owner-sitting.md` were read in full; the closest neighbours are `### [pi] Standing 'Compact Instructions' are skipped on the auto-compaction turns where our summary replacement is off` (ledger E3, steering what compaction PRESERVES) and sitting §1.8 (output-style timing), neither of which asks about reopening a stale conversation. `resumeFromSummary` scores 0 files across `packages` + `apps`, and 0 over all 172 unfinished tracker rows.)

### F#0

- Everything else in this slice is new. The 28 headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and the 20 of `docs/superpowers/specs/2026-09-04-owner-sitting.md` were read in full; no heading in either file names a session, a transcript, a checkpoint, a rewind, a retention horizon, a usage limit, a session list, a prompt history or a background job. The nearest neighbours, and why each is a different subject: `### [claude] Claude's own session store is readable, and our own sessions are written into it — do we surface it?` is ledger F4 (browsing the RUNTIME's own thread store, which the F27 screen deliberately does not touch — that one is over OUR records); `### [host] A throwaway in-memory fork — build the affordance, or record the clause as declined` is ledger F3's `ephemeral` param, which the in-place-branch ROW above explicitly leaves to it; sitting §1.9 (the iOS pipeline) and §3.2 (a codex teardown refusing the switch) share no subject with anything here.

### G#0

(none — no G6–G25 entry is already carried by
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` or by
`docs/superpowers/specs/2026-09-04-owner-sitting.md`. Two near misses, checked and rejected as
duplicates: sitting **§1.2** *"A user-scope `env` block is declared, loudly rejected, and never
applied"* decides the settings `env` key applied to the agent process, not hook-child inheritance —
cross-referenced in the question above rather than folded into it; sitting **§2.3** *"Skills reach
claude as host-rendered prompt text"* is already cited as `sitting_ref` by the G17 tracker row and
is NOT re-asked here.)

### H#0

- **H19** [pi] [claude] [codex] — already ruled, no new question. → `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` §"DR-2" of the decisions ledger (the background auto-commit entry; it sat at line 1145 before the plan's CLOSED banner)` verbatim: *"DR-2 — background auto-commit: RESOLVED 2026-08-22 — split approved … draft-MR half (L, GitLab forge integration) goes to a separate forge/git-UI plan together with the git panel and integrated terminal (Dev-4)"*; also `:1923` (*"local-environment setup scripts → P3.6 (git panel deferred, Dev-4 cluster)"*) and `:2079` (*"Dev-4 background draft-MR/PR half"*). The same ruling absorbs the separate "Create branch here" candidate and the out-of-scope register's hunk-staging row. One item in the sweep's reading is worth carrying to Dev-4: codex DOES expose a native diff source, `gitDiffToRemote` (`packages/codex-protocol/generated/ClientRequest.ts:100`), and ledger H1 already computes a host-side diff — the diff is not the missing part; hunk staging, inline review comments and the forge action are. (The line-anchored-comment half is carried as a BUILDABLE row in `rows-H-0.md`.)
- **H52** [pi] [claude] [codex] — already ruled, no new question. → `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:2076` verbatim: *"Dev-1 agent-teams: not taken for now (owner 2026-08-22)"*; plan line 15 (*"Agent-teams: NOT taken for now (deviation)"*); and `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md:699` — R23, verbatim *"Agent teams — declined, 2026-07-29 (owner decision)"*. Owed anyway, and NOT a question: the honest surface (`TeammateIdle`'s named refusal at `packages/shared/src/plugins/format-adapters.ts:132` is the pattern; `packages/server-core/src/pi-harness/mailbox-service.ts:4-11` refuses with `peer-messaging-disabled`; `packages/shared/src/sessions/types.ts:408` *"R23 agent-teams machinery… Never written."*), and keeping codex's live `multi_agent_v2` deliberately OFF (`packages/codex-responses-adapter/src/config-writer.ts:255-268`, confirmed against `rust-v0.148.0` `features/src/lib.rs`). Reopen trigger recorded by the sweep: someone wanting peer sessions to claim work from one queue with no human routing it. The related plan-approval carve-out (`agent-teams.md:175`) is already out of scope in the denominator's own §H out-of-scope table.

### I#0

None of the four questions above is already asked. Two group-I entries whose decisions ALREADY EXIST are
recorded in `rows-I-0.md` §Already open rather than here, and are cross-referenced (not re-placed):

- I6 — the macOS seatbelt wildcard: carried by `docs/superpowers/specs/2026-09-04-owner-sitting.md` §1.1
  AND by open plan row P3.330 (⏸, blocked on that same answer). Not restated.
- I33 — WSL: ruled by the owner as a spike already taken (plan `:12`, tracker `:3176`); open plan row P3.7,
  parked on the absence of a Windows rig, not on an answer.

### J#0

- **J25** `[pi][claude][codex]` — LSP code intelligence (post-edit diagnostics, jump-to-definition, references, workspace symbols, implementations, call hierarchies) → **`sitting §4.1`** ("The native LSP fallback has no producer, in production or in any test"), with the claude arm blocked by **`sitting §2.3`** ("Skills reach claude as host-rendered prompt text, not as the filesystem artifacts the runtime loads") — the native route on claude is a code-intelligence PLUGIN, and §2.3 already owns whether plugin components reach claude as artifacts. Plan rows: **P3.366 ⏸** (`f6dccdf1e`, the Pi decision) and **P3.297 ⬜** (the skills-as-prompt-text arm). The sweep's own instruction is explicit: "do not open a third question". Residue worth carrying into whichever row executes §4.1: `git grep -an "'LSP'"` over non-test `*.ts` returns exactly one line — `packages/shared/src/agent/always-allowed-tools.ts:37` (`'LSP', // Language server (read-only)`) — so on claude and codex the tool NAME is permission-listed with no tool behind it, and the narrow useful residue is post-edit diagnostics, which need no navigation surface.

### J#1

*(none of J57, J58, J59 is a question already before the owner)*

Two adjacent pages were checked for each entry and neither carries these capabilities — recorded so the
adjacency is not mistaken for a duplicate later:

- `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` — all 28 `### [<runtime>]` headings
  read; the nearest are *[host] Website-declared tools (WebMCP / "site tools") in the built-in browser* and
  *[pi + claude + codex] Sharing a worktree `setupScript` through the repository — I5/pi, I5/claude, I5/codex*.
  The second is the closest to **J59** and is a different question: it asks whether a worktree-creation setup
  script may be shared through the repo, not whether a saved command is user-invocable from the app.
- `docs/superpowers/specs/2026-09-04-owner-sitting.md` — all headings read; the nearest is **§1.2 "A
  user-scope `env` block is declared, loudly rejected, and never applied"** (tracker row P3.373 ⏸,
  `216da994a`), which the denominator named as **J57**'s blocker. **It is not a blocker** — measured at HEAD,
  the troubleshooting page names the shell environment as the first of two routes and the host owns the SDK
  child's environment directly at `packages/shared/src/agent/options.ts` symbol `buildClaudeSubprocessEnv`
  (`buildClaudeSubprocessEnv`, which already writes `ENABLE_TOOL_SEARCH` at `:680`). J57 therefore needs no
  ruling on §1.2 and is not held behind it.

### K#0

None. No group-K entry is already asked on
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` (28 headings, none about models, effort,
service tier, prompt caching or streaming) or in `docs/superpowers/specs/2026-09-04-owner-sitting.md`
(§1.1–1.9, §2.1–2.3, §3.1–3.4, §4.1 — none about models or effort).

One nearby entry is ALREADY RULED and therefore carries no question: **K25** (the codex model preference list) is
P2.318, ⏸ PARKED as GATED 2026-09-02 under the owner's 2026-08-29 ruling on the ChatGPT Plus/Pro card — *do not
build, do not delete, do not clean up*. It is filed under `## Already open` in `rows-K-0.md`, not here.

### L#0

- **L29** [host] Set environment variables for every local session and for dev servers from an editor in the app,
  stored encrypted on the machine. → sitting §1.2 ("A user-scope `env` block is declared, loudly rejected, and never
  applied"; `docs/superpowers/specs/2026-09-04-owner-sitting.md:73-102`, VERIFIED — three premise corrections,
  `execution`/`PATH` named as the load-bearing withheld category, options (A) refuse permanently and disclose /
  (B) apply behind a name allowlist, controller recommending (A)). Tracker row P3.373 (⏸) carries the same decision.
  Not restated. The only part L29 adds and §1.2 does not is the ENCRYPTED-AT-REST storage and the in-app editor,
  which are downstream of the same yes/no and cost nothing to specify once it is answered.

### L#1

(none of this slice's four questions is already asked). Nearest existing entries, checked and distinct:

- `2026-09-05-ledger-closure-owner-questions.md#[host] Should the app gain a route for git repositories on hosts other than github.com and `*gitlab*`?` — ledger L13's forge routing, not a catalog default (L63/L90).
- `2026-09-05-ledger-closure-owner-questions.md#[host] Should a vendor's own skill-invocation spelling do anything when a user pastes one?` — ledger L11's `$plugin:skill` spelling, not skill acquisition (L62/L63).
- `2026-09-05-ledger-closure-owner-questions.md#[host] Should a marketplace's `headersHelper` command be executed to mint an archive-download credential?` — ledger L12's credential, already carried by P6.177.
- `2026-09-05-ledger-closure-owner-questions.md#[host] Should the skill listing's budget be a share of the context window, as the page documents, or stay a flat character cap?` — ledger L10, out of this slice.
- `2026-09-04-owner-sitting.md §2.3` — skills reach claude as host-rendered prompt text; a CONSTRAINT cited by the L64 row, not a question this slice re-asks.

### L#2

- (none from this slice) — checked all 27 entries against the 28 `### [<runtime>]` headings in
  `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and the 20 headings in
  `docs/superpowers/specs/2026-09-04-owner-sitting.md`. Two near-misses, recorded so they are not re-asked
  elsewhere and are NOT counted as questions of this slice:
  - L116's residue (a git host that is neither `github.com` nor `*gitlab*`) → `2026-09-05-ledger-closure-owner-questions.md`
    "### [host] Should the app gain a route for git repositories on hosts other than github.com and `*gitlab*`?" —
    L116 itself is filed as STRUCTURAL, surface present, in `rows-L-2.md`.
  - L118's `additionalDirectories` arm → sitting §1.4 ("One `additionalDirectories` setting, three treatments, and
    the Pi arm is inert") and tracker row P3.339 — the L118 measure row inherits that answer and measures only the
    other three keys.

### M#0

- None of the five questions above is already asked. Adjacent entries in this slice were checked against both
  pages and are pointers rather than questions:
  - **M7 [codex]** — the per-thread USD readback (`account/usage/read` → `ThreadUsage.estimatedUsageUsdMicros`)
    is already asked: `2026-09-05-ledger-closure-owner-questions.md` › `### [codex] Codex ships a USD readback
    of its own: wire it, or hold the ruled explicit null?`. The M7 tracker row therefore carries the pi, claude
    and host arms only and cites that question for the codex arm.
  - **M6 [codex]** — the rate-limit family (`account/rateLimits/read`, `account/rateLimits/updated`) is NOT that
    question: it is token-window telemetry, not a USD figure, and it is written as a measure: tracker row.
  - **M39 [codex/host]** — the `otelHeadersHelper` half needs no question: it is already ruled out by the
    2026-08-08 decision that this product accepts no admin-supplied executable as a settings source
    (`packages/shared/src/config/managed-env.ts:838-852`). The unruled mTLS half is a tracker-row unit inside
    the host-exporters row. The adjacent `### [codex] Codex accepts OTLP auth headers only as literals on disk`
    question governs codex's own `config.toml` credential, not the host exporters' transport, and is not
    re-asked here.

### N#0

_(none — neither question in this slice is a restatement.)_

Both dedupe greps above returned no cross-session heading in either destination, and the one place that could have
carried them — `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` `### N` — records its own null
for the N1–N3 cells it covered, with its dedupe check quoted at line 1441
(`grep -ain 'cross-session|send_agent_message|crossSessionInbound|dialogExpiry|inbound'` over the sitting page →
**0 hits**). N10 and N11 are the first OWNER cells this section has produced.

### O#0

- **O12** [host] — *Use the other follow-up behaviour for ONE message — queue on a steer-default connection, or steer on a queue-default one — without changing the stored default.*
  → `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md#host-a-one-message-override-for-the-steer-vs-queue-default`
  (heading `### [host] A one-message override for the steer-vs-queue default`, ledger cell `O5-host-override`; options A/B/C with recommendation **B** on Alt/Option+Enter, and the parity direction already written there.)
- **O20** [host] — *See the review state of the branch's pull request or GitLab merge request while you work — including an `MR !N` footer badge coloured draft / open / mergeable.*
  → **already_ruled, no new question:** `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` §"Recorded deviations (harvested by P5.3)" — "Dev-4 background draft-MR/PR half: separate forge/git-UI plan (GitLab MR, auth, git panel, integrated terminal cluster)". Corroborating triage: `docs/superpowers/specs/2026-08-28-claude-sweep-triage.md:1288` (F129.3) and `:3560-3563` (F191.6); `git grep -ain 'pr\.kind\|review_state\|reviewState'` over the statusline surface → 0 at HEAD. The `whats-new/2026-w34` footer-badge half is the same capability's chrome and shares the `glab` credential prerequisite — sequence the two together in that plan, or neither.
- **O21** [host] — *Configure a status bar that runs your own script on stdin JSON and shows context usage, cost, git state, rate limits and cache warmth.*
  → **already_ruled, no new question:** `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md:786` — R53, "**DROPPED 2026-08-08 (owner)** for `statusLine`, the terminal bottom bar" (the same row records that `subagentStatusLine` was split out rather than dropped). At HEAD: "Nessy renders no status line, so the declared command is never run" (`packages/shared/src/plugins/format-adapters/claude.ts` symbol `normalizeClaudePluginDefaultSettings`); page `statusline.md` :9, gates at :1086. Listed only so the ledger stops carrying `statusline` as an unscored gap on two runtimes — it is an execute-a-shell-command key under the same trust / `disableAllHooks` / `allowManagedHooksOnly` gates as hooks, i.e. a permission surface, so the drop should be recorded with that reason rather than as decoration.

## Adjacent, not merged

Pairs checked for "one decision asked from two groups" and kept apart, with the distinction that separates them.
Recorded so a later reader does not mistake the adjacency for a duplicate.

- **B16** (*[host] Does the built-in browser owe an administrator a graduated policy…*) vs **J12+J14**
  (*[host] Governing the built-in browser — per-site approval and the CDP grant*): the first decides an
  ADMINISTRATOR-facing managed policy over the pane, the second a USER-facing per-origin trust store plus the
  full-CDP grant. Different deciders, different surfaces, disjoint ledger ids; J's option 2 already names the
  operator allowlist as a shared list, so answer them in the same sitting, not as one question.
- **A87** (*[host] Does the Windows build owe a WSL2 agent mode?*) vs **I32** (*[host] Windows: keep the weaker
  `unelevated` sandbox…*): one is whether a second execution environment exists on Windows at all, the other is
  which of codex's two Windows sandbox tiers we spawn.
- **H47** (*[host] A budget a long task paces itself against: USD, tokens, or both?*) vs **M9+M10** (*[host]
  Should an operator be able to supply the model price table…*): one decides whether a run paces itself, the
  other where the prices that any such pacing would read come from.
- **G15** (*[host] How does a user's own environment reach a host-run command hook?*) vs sitting **§1.2** (the
  settings `env` block applied to the agent process): different seams, same containment argument — the G15
  question already cross-references §1.2 and asks that the two be answered together.

## Slice provenance

Each slice file's own preamble — input section, dedup denominator, HEAD at composition — kept verbatim so the
method behind the entries above is not lost in the stitch.

### A#0

# Denominator group A, entries 1–45 of 75 (A13–A57) — owner questions

Five new questions (A17, A26, A33, A37, A38) and one already asked (A20). Each closes a cell whose answer
changes a product posture; none of the five is asked in
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` or
`docs/superpowers/specs/2026-09-04-owner-sitting.md` — checked by identifier against the plan as well
(`normalizePersistedSessionPermissionMode`, `clampArrivingBypass`, `ACCEPT_EDITS_FILESYSTEM_COMMANDS`,
`skipDangerousModePermissionPrompt`, `permissionExplainerEnabled` and "no user present" all score **0** in
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, so no owner ruling exists for any of them).

### [host] What permission mode does a reopened session start in?

*(Denominator A17 — pi `partial`, claude `partial`, codex `partial`; size S. Ours: the mode manager is
host-side, and no runtime restores this for us — the claude SDK is spawned per session with the mode we
pass, and codex likewise.)*

Today a session is restored into whatever mode it ended in. `packages/server-core/src/sessions/SessionManager.ts` symbol `normalizePersistedSessionPermissionMode`
`normalizePersistedSessionPermissionMode` → `:10853` `setPermissionMode(..., { changedBy: 'restore' })`;
the only clamp, `clampArrivingBypassForHost` (`:26012-26022`), fires ONLY when the host refuses bypass
(root/sudo outside a container), so on an ordinary desktop a session that ended in `bypassPermissions`
**reopens in it**, which the page's first resume-table row forbids. `plan` is restored unchanged and
`auto` gets no eligibility re-check. `normalizeSessionPermissionMode` (`:25993-25997`) carries a Pi-only
branch, so the three runtimes are not even identical today.

- **A. Follow the page's resume table** — buys: `bypassPermissions` and `plan` are never silently
  restored and `auto` is re-checked against current eligibility, so reopening a chat can never be more
  permissive than opening a new one — costs: a user who deliberately ended in plan mode must re-enter it;
  the app remembers less than it used to.
- **B. Keep today's full restore** — buys: session intent survives verbatim on all three, and no code
  changes — costs: a session that ended in `bypassPermissions` reopens in it on an ordinary desktop, and
  nothing catches it; this is a silent widening across a restart.
- **C. Split — bypass and auto follow the page, `plan` is restored** — buys: the dangerous half is fixed
  and the harmless intent is kept — costs: our resume behaviour differs from the documented table in one
  named row, which must be written into the mode picker's runtime clause.

**Recommendation:** C. It takes A's safety on the two modes that matter and B's intent on the one that
does not, at the price of one stated divergence.

**Closes the difference:** A closes it against the documented contract on all three runtimes; C closes it
except for `plan` and owes one honest sentence; B does not close it.

### [codex] What should an unattended codex turn do with a call no rule covers?

*(Denominator A26 — pi `have`, claude `have`, codex `partial`; size M.)*

The correction first: the floor is already closed on codex. `codex-agent.ts:4154-4162` REFUSES when a
floor matches (`Refused with no user present: the … floor is non-negotiable`) and only auto-approves at
`:4162` when **no** floor matches. Pi and claude are fail-closed (`pi-agent.ts:6706`,
`packages/shared/src/agent/claude-agent.ts` symbol `CAN_USE_TOOL_NO_SURFACE_DENIAL`). So the open case is the no-rule call, on one
runtime, with nobody there to ask.

Codex has an unused native mechanism for exactly this: `AskForApproval` in `config-schema.json` — `never`
("Never ask the user to approve commands") and the granular variant whose false fields are "automatically
rejected instead of shown to the user".

- **A. Deny, as Pi and claude already do** — buys: one fail-closed behaviour across all three, and the
  switch report loses a SILENT-LOOSER row — costs: unattended codex jobs stall at the first uncovered
  call, so a scheduled run that used to finish now fails.
- **B. Keep auto-approving and pay the honesty instead** — buys: unattended jobs keep completing, nothing
  to re-verify — costs: on one runtime the ABSENCE of a human widens what runs, which is the worst
  direction for a default; a documented divergence is copy, not protection.
- **C. Operator setting defaulting to deny, wired to codex's own `AskForApproval` granular rejection** —
  buys: native-first (the mechanism exists and we simply never write it), the deployment chooses, and the
  default is the safe one — costs: one more managed key to keep true and to score for enforcement.

**Recommendation:** A as the behaviour plus C as the escape hatch. The native-first rule points here: the
runtime already has the switch, we have never written it, and a build proposal must say so.

**Closes the difference:** A — and C at its default — closes it; B converts a silent widening into an
honest one, which is the host's job but is not parity.

### [host] May a developer widen the judge's trust boundary on their own machine?

*(Denominator A33 — pi `partial`, claude `partial`, codex `partial`; size M. Also gates the editor half of
the permissions/judge surface row and the shape of the managed-only `autoMode` tripwire.)*

The page lets a user name the repos, source-control orgs, buckets, domains, registries and services their
organisation trusts, splicing `"$defaults"` to keep the built-ins (`auto-mode-config.md:64,76,100`). We
implement the managed scope only, and deliberately: `AUTO_MODE_KEYS = ['environment','hard_deny',
'soft_deny','allow']` parsed entry-by-entry from the managed policy (`managed-policy.ts:841`, `:843`), a
fixed host-built list on claude (`claude-auto-mode-policy.ts:254`, `:303/:332/:345`, `:366-376`), and on
codex a real but empty free-text channel we already wire (`config-defaults-schema.ts:61-67`,
`packages/shared/src/agent/codex-agent.ts` symbol `buildCodexAutoReviewOptions`; codex's own
`packages/codex-protocol/schema/config-schema.json` symbol `AutoReviewToml` declares exactly one
property, `policy: string`). There is no
user scope and no UI anywhere (`git grep -ain autoMode -- packages/shared/src/config apps/electron/src
packages/ui` → one unrelated test comment).

- **A. Managed scope only — today's shape** — buys: a repository, a build step or a compromised toolchain
  can never widen what the judge trusts, matching the two sites that already say so in comments — costs:
  the page's own user scope is unimplemented on all three; a developer's own registry has to go through an
  administrator, every turn until then.
- **B. User scope, additive, with `"$defaults"` splicing as the page specifies** — buys: documented
  parity, and the judge stops flagging a developer's own hosts — costs: the trust boundary of a safety
  judge becomes user-writable; the page itself warns about this, and a file write is the cheapest thing an
  attacker gets.
- **C. User scope for `hard_deny`/`soft_deny` only (narrowing), managed-only for `allow`/`environment`** —
  buys: a developer can make the judge stricter and never looser, which is the same
  direction-of-strictness contract the fork already applies to managed settings (ledger A8) — costs: a
  documented key half-honoured, and the asymmetry must be stated at the settings surface.

**Recommendation:** C. It is the only option that cannot loosen a judge, and it reuses a rule this tree
already has rather than inventing one.

**Closes the difference:** B closes it against the page; C closes the half that does not trade safety; A
does not close it and owes the honest surface instead.

### [host] Accept Edits: four filesystem commands, or the page's six?

*(Denominator A37 — pi `partial`, claude `partial`, codex `partial`; size S. Host-side gate, one set for
all three runtimes — the same `pre-tool-use.ts` ledger A2 records as covered.)*

Two vendor pages disagree and our record answers the question twice, oppositely.
`packages/shared/src/agent/core/pre-tool-use.ts` symbol `ACCEPT_EDITS_FILESYSTEM_COMMANDS` is `const ACCEPT_EDITS_FILESYSTEM_COMMANDS = new Set(['mkdir','touch','mv','cp'])`,
whose docblock directly above it cites `agent-sdk/agent-loop.md`'s four-item "etc." list and adds "The etc.
is not an invitation to invent entries." `security.md:34` names six, adding `rm` and `sed`. Meanwhile
`2026-08-02-claude-doc-sweep-divergences.md:478` calls the four "a recorded bank decision, not a defect",
while `2026-08-28-claude-sweep-triage.md` F98.3 marks it TAKE · never looked at, its evidence line reading
"NOT MEASURED in this pass".

- **A. Keep four (`mkdir`, `touch`, `mv`, `cp`)** — buys: Accept Edits never auto-approves an unattended
  deletion or an in-place rewrite; `rm` and `sed` keep prompting — costs: a documented six-item list is
  honoured as four on all three runtimes, and that must be stated in the mode description.
- **B. Adopt all six** — buys: exact parity with `security.md`, and a user who chose Accept Edits stops
  being asked about the edits they asked for — costs: `rm` under Accept Edits is unattended deletion
  inside the working directory, which is the one class the fork's own floors exist to slow down.

**Recommendation:** A — and settle the record in the same pass, because two live documents currently give
opposite answers and the next lane will read whichever it finds first.

**Closes the difference:** B closes it as parity; A keeps it and owes one sentence in the mode description
plus a corrected record.

### [host] Adopt the vendor's confirmation-suppression switches, or refuse them by name?

*(Denominator A38 — pi `absent`, claude `partial`, codex `absent`; size not scored by the sweep.)*

`skipDangerousModePermissionPrompt` IS in the vendored bundle (`grep -aoF` → 1; controls `Cookie` → 5,
`git-subdir` → 4) and reachable from a **project** settings file, because we pass
`settingSources: ['user','project','local']` (`packages/shared/src/agent/claude-agent.ts` symbol `settingSources`). So today a repository can suppress
the dangerous-mode confirmation on a claude session and nowhere else. Its auto-mode twin
`skipAutoPermissionPrompt` is absent from the bundle (→ 0) and appears in our tree only in two test files.
We implement neither (`git grep -ail -F skipDangerousModePermissionPrompt` over `:(glob)packages/**`
`:(glob)apps/**` → 0 files) — the confirmation is ours on Pi and codex.

- **A. Implement host-side, uniformly on all three** — buys: one behaviour instead of a key that works
  only on claude sessions, and an operator who suppresses the dialog gets what they configured — costs: we
  ship a supported way to remove a safety confirmation, reachable from a project settings file, i.e. from
  a repository.
- **B. Refuse by name and block the SDK key** — buys: the dangerous-mode confirmation cannot be suppressed
  by any file on any runtime, and the current claude-only asymmetry disappears in the safe direction —
  costs: a documented vendor key stops working on claude, which must be named where the refusal happens.
- **C. Honour it from the managed scope only** — buys: a deployment that has already decided can suppress
  the dialog, while a repository cannot — costs: a third scope rule to keep true, and the confirmation is
  still removable.

**Recommendation:** B for the project and local scopes at minimum, because today's reachable path is the
repository one; C on top if the operator case is real.

**Closes the difference:** A closes it as parity and pays with a repository-reachable safety-prompt
removal; C closes it in the safe direction; B closes it by removing the capability everywhere and owes a
named refusal.

### A#1

# Denominator group A, in-scope entries 46–75 of 75 (A58–A87) — owner questions

Checked against the headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and
`docs/superpowers/specs/2026-09-04-owner-sitting.md` before writing; anything already asked or already
ruled is a pointer in `## Already asked` at the end, not a restatement.

### [host] A subagent's declared permission mode: clamp it (ours) or ignore it (the page)

**Closes:** Denominator A58 — pi `partial`, claude `partial`, codex `partial` (one shared host mechanism,
so the answer lands on all three at once).

`agent-sdk/permissions.md:119` says a subagent's declared permission mode is **ignored** when the parent
session is in `auto`, `acceptEdits` or `bypassPermissions`. Ours **clamps**: `requestedRank <= parentRank
? requested : parent`, with one hand-written carve-out for the incomparable `plan`/`explore` pair. So a
child may run NARROWER than such a parent — a deviation in the safe direction, and undeclared anywhere a
user or an operator reads.

- **A — record the deviation, change no code** — buys: the safe direction is kept (a subagent can only
  ever be tighter than its parent), costs nothing, and one written deviation makes it honest; the
  carve-out stays where a reader can find it. — costs: we knowingly diverge from the page on a
  permission surface, so the next lane reading the page will "fix" it again unless the deviation is
  pinned by a test.
- **B — match the page: ignore the child's declared mode under those three parents** — buys: exact
  conformance with the documented contract, and one fewer place where our permission semantics differ
  from what a Claude-shaped plugin or agent definition expects. — costs: it **LOOSENS** what a subagent
  may do — an agent definition that deliberately declares `plan` would start running with the parent's
  `bypassPermissions`; that is a real safety regression bought for conformance.

**Recommendation:** **A** — record the deviation, pin it with a test, and say so in the agent-definition
docs. Conformance is not worth loosening a permission floor, and the page's own narrower twin
(`permission-modes.md:467`, auto-mode subagents only) shows the contract is not settled upstream either.

**Parity direction.** Neither option changes a cross-runtime difference: the clamp is host-side and shared
by all three, so this is host-vs-page, not runtime-vs-runtime. **B closes the difference with the page;
A closes it with a declaration.**

**Evidence:** `agent-sdk/permissions.md:119` (the sentence scores 0 in `permission-modes.md`; that page's
own narrower version is at `:467`); implementation `mode-types.ts:156-166`, carve-out at `:164`;
`runtime-agent-definitions.ts:420` forwards `descriptor.permissionMode`;
`packages/pi-agent-server/README.md` §"Definition schema" (the `permissionMode` row) "Invalid values warn-and-ignore to inheriting the parent".

### [codex] "Approve for me": a selectable mode, a codex-only setting, or folded into `auto`

**Closes:** Denominator A65 — pi `absent`, claude `absent`, codex `partial`.

*Not the same question as* `2026-09-05-ledger-closure-owner-questions.md#[codex] Codex ships its own
model-backed approval reviewer, we already wired it, and it is default-OFF` — that one asks whether the
reviewer is ON by default. This one asks **what the user selects to get it**. The mechanism itself is
landed (plan line 22): `approvals_reviewer = "auto_review"` plus optional `[auto_review].policy`,
setting-gated, emitted only when the resolved policy is interactive. What is absent is a *mode* — today
the behaviour rides an unrelated setting, so a user who wants "keep the workspace boundary, but send the
crossings to an automatic reviewer instead of to me" cannot ask for it by name.

- **A — a codex-only setting, named in the settings page and in the switch report** — buys: smallest
  change, no new entry in the permission-mode control, no promise on runtimes that cannot keep it. —
  costs: the capability stays invisible where users choose their safety posture; the mode picker keeps
  claiming to be the place safety is decided while a second place also decides it.
- **B — a mode on all three runtimes, `absent-with-reason` on Pi and claude** — buys: the user meets it
  where they already choose a posture; the switch report can say, in one sentence, what selecting it
  costs on the other two; it is the only option that makes the difference legible at the switch. —
  costs: an eighth mode in a control the owner has already been asked to simplify (see the seven-modes
  question below), and two runtimes where selecting it degrades to something else.
- **C — fold it into `auto`** — buys: no new surface at all; `auto` already means "do not ask me", so
  routing the crossings to codex's reviewer is a strict improvement inside a mode that exists. — costs:
  `auto` then means different things per runtime, which is the exact divergence class this plan exists
  to remove; and the reviewer's emit gate requires an interactive policy, so `auto` would have to stop
  resolving to `never` on codex — a behaviour change smuggled inside a naming decision.

**Recommendation:** **B** — but sequenced after the default-ON/OFF question above, because a mode nobody
can reach by default is worth less than an honest setting. If that question answers **A** (stay opt-in),
take **A** here too and revisit.

**Parity direction.** **B closes the difference** — it is the only option that puts the capability in the
same control on every runtime and forces the two absences to be stated. **A and C leave it a codex
secret** (C additionally makes an existing mode diverge).

**Evidence:** `packages/codex-responses-adapter/src/config-writer.ts:313-330` (setting-gated, default off,
emitted only when the resolved policy is interactive), `:655-663` (`CodexApprovalsReviewer =
'auto_review'`, legacy `guardian_subagent` never emitted), `:2623` (`emitAutoReview = … &&
approvalPolicy !== 'never'`); `packages/shared/src/agent/codex-config-requirements.ts:370` classifies
`autoReview` as codex-enforced; plan line 22 (mechanism taken), P3.2 `384e2fb38`+`7736e32a9`.

### [codex] Seven fused permission modes, or codex's own two axes and its named profiles

**Closes:** Denominator A67 (pi `absent`, claude `absent`, codex `absent`) and A68 (pi `n/a`, claude
`n/a`, codex `absent`) — one posture decides both.

Codex's own configuration keeps **sandbox** and **approvals** as two independent keys (`sandbox_mode`,
`approval_policy`) and supports **named permission profiles** (`[permissions.<name>]`,
`allowed_permission_profiles`, `default_permissions`). We fuse the two axes into seven named modes — one
frozen pair per mode, four of the seven emitting an identical pair — and we write exactly ONE profile,
`[permissions.nessy_runtime]`, derived from that table. So a user cannot change *who reviews* without
also changing *what the agent may touch*, and cannot select a profile at all.

- **A — keep the seven fused modes; spend the effort on making their descriptions true per runtime** —
  buys: one safety control with the same meaning on all three runtimes, which is the whole switch-safety
  argument; the known defect (ledger A11 — descriptions false on codex) is cheap to fix. — costs: two
  native capabilities stay unreachable; a codex-native user meets a smaller product than codex offers.
- **B — expose both axes, keep the seven as presets** — buys: the sandbox and the approvals can move
  independently on the runtime that supports it; presets keep the simple path simple. — costs:
  re-teaches the central safety control, and the two axes have no meaning on Pi or claude, so either the
  control is codex-only or two runtimes show a degraded version of the primary safety UI.
- **C — B, plus surface user-authored codex permission profiles** — buys: the full native model, and an
  operator can ship a profile per project. — costs: B's costs, plus "permission mode" then names
  different things per runtime — a user-authored profile has no Pi or claude twin at all, and the ADMIN
  requirement (ledger B5) already covers the operator case without a user-facing selector.

**Recommendation:** **A** for both — keep seven, fix the descriptions. The capability lost is real, but
the thing being protected is the one control a user reads before allowing a destructive action, and it is
the only control that must mean the same thing after a runtime switch.

**Parity direction.** **B and C close the difference with codex** (C fully), at the cost of *opening* a
difference between runtimes. **A does not close it; it declares it** — which under the native-first rule
is the host's job, but is not parity. Whichever is chosen owes a switch-cost sentence.

**Evidence:** `packages/codex-responses-adapter/src/config-writer.ts` symbol `CODEX_PERMISSION_MODE_TABLE`,
exactly seven frozen `{sandbox_mode, approval_policy}` pairs (dontAsk, explore, plan, default,
acceptEdits, auto, bypassPermissions), four emitting an identical pair; `:1311-1313` derives the sandbox
from the mode alone; `:2738-2741` emits `sandbox_mode` plus `default_permissions = "nessy_runtime"`;
`config-writer-permissions.ts:60`, `:746-793` builds that one profile; repo-wide
`allowed_permission_profiles`/`allowedPermissionProfiles` → 4 generated-protocol/schema files, one
comment (`codex-agent.ts:6126`), one classifier entry (`codex-config-requirements.ts:369`) — no writer,
no reader. Pages `permission-modes` (refuted line refute_codex_3, row 89), `learn.chatgpt.com` sandboxing
row 101 (weak tier).

### [codex] An unbounded `**` deny-read glob: bound the scan, or keep the honest warning

**Closes:** Denominator A69 — pi `n/a`, claude `n/a`, codex `partial`.

Codex refuses to expand an unbounded `**` deny-read glob past a match ceiling and degrades it to a
startup warning on Linux and Windows. It offers `glob_scan_max_depth`. We deliberately do NOT write it,
because writing it **silences the warning by capping the expansion** — the deny stops applying below the
cap while the config still claims it. Windows is an arm we ship.

- **A — leave it unset and keep the warning** — buys: the config never claims a deny it is not applying;
  the operator sees the warning and can narrow the pattern. — costs: on Linux and Windows an unbounded
  deny-read glob does not deny, and the only thing standing between the model and those paths is a
  message at startup.
- **B — write a bounded `glob_scan_max_depth` on the affected platforms** — buys: the deny applies within
  the depth, on the platforms where today it applies nowhere. — costs: it converts a loud partial failure
  into a silent partial success — below the cap the deny is real, above it the rule is quietly inert and
  nothing warns; that is a control that stops controlling, the class this plan treats as worst.

**Recommendation:** **A** — leave the warning. This tree measures 43 matches across all nine shipped
patterns against a ceiling of 8192, so the warning does not fire in our own configuration; the risk is an
operator's own broad pattern, and for that a loud failure beats a quiet cap. Revisit only with a
measurement of a real operator pattern that trips the ceiling.

**Parity direction.** **B closes the difference** with codex's own capability; **A keeps the honest
surface** and leaves the deny unenforced above the ceiling. Codex is the only runtime with a subject
here, so neither option changes a runtime-to-runtime difference.

**Evidence:** `packages/codex-responses-adapter/src/config-writer-permissions.ts:200-213` verified
verbatim ("deliberately NOT written … the one knob a reader will reach for", citing codex
`permissions.rs:370-378`), with the named cost of leaving it unset at `:209-213`
(`MAX_UNREADABLE_GLOB_MATCHES = 8192`, `bwrap.rs:56`, `:744-748`; this tree measures 43 matches across
all nine patterns). No owner ruling in the plan's decision sections or the out-of-scope register.

### [host] May an untrusted MCP server's `readOnlyHint` let its tool skip our gate?

**Closes:** Denominator A74 — pi `absent`, claude `absent`, codex `absent`.

Codex HAS the mechanism (`default_tools_approval_mode` per server, `approval_mode` per tool) and our
writer emits neither, deliberately. Claude has the ANNOTATION and no approval axis on it. Native-first
cannot simply be taken here for two independent reasons: user MCP servers reach codex as ONE aggregated
`[mcp_servers.sources]` proxy, so codex's per-server key cannot address a user's individual server; and
our own recorded invariant says a tool annotation is *"ADVISORY ONLY … a hint from a possibly untrusted
server and must never become an authorization signal"* — test-pinned. The narrowing counterpart is
already built and states the asymmetry: it is admissible *"only because it can exclusively NARROW
access."* So honouring `readOnlyHint` to SKIP a prompt reverses a pinned invariant in the loosening
direction — an owner call, not a lane's.

- **A — keep the invariant; write the deviation** — buys: an untrusted server can never lower its own
  gate; one written deviation explains why a documented codex capability is unemitted. — costs: users
  keep approving read-only MCP calls one at a time on every runtime; a real ergonomic cost that pushes
  people toward blanket allow rules, which is the worse outcome.
- **B — honour the hint only for operator-allowlisted servers** — buys: the ergonomics where the trust
  already exists (the operator, not the server, is the authority), and it composes with codex's own
  per-server key for the servers that are addressable; the invariant survives for everything else. —
  costs: a new allowlist surface and its managed-policy key; the aggregation problem means the codex arm
  is host-side anyway, so the mechanism is ours to maintain on all three.

**Recommendation:** **B**, scoped so the allowlist is operator-owned and empty by default — never a
blanket writes mode, and never the hint alone. If B is not funded, take **A** and write the deviation.

**Parity direction.** **B closes the difference** on all three at once (host-side, so uniform by
construction) and is the only option that lets codex's native per-server key ever be emitted. **A does
not close it; it declares it.**

**Evidence:** `packages/shared/src/mcp/mcp-pool.ts:470-476` (the advisory-only invariant), pinned by
`packages/shared/src/mcp/__tests__/proxy-tool-names.test.ts` anchor `does not project advisory protocol metadata into authorization fields`; the narrowing counterpart
`packages/shared/src/mcp/mcp-pool.ts` symbol `interactionRequiredProxyToolNames`; annotations carried at `mcp-pool.ts:1525`,
`:2903`, `pool-server.ts:436` with no permission path reading them; codex side —
`default_tools_approval_mode` 4 hits and per-tool `approval_mode` 6 hits in
`packages/codex-protocol/schema/config-schema.json`, absence pinned with a positive control at
`packages/codex-responses-adapter/src/__tests__/config-writer.test.ts:263-271` and its reason in the plan
at `:2632` (T5); claude — `readOnlyHint` occurs once in the vendored `sdk.mjs`; page `extend/mcp` (row 67).

### [host] A second permission authority: approving a tool prompt from a phone over a channel

**Closes:** Denominator A75 — `absent` on all three for the CHANNEL route.

`channels-reference` describes answering a tool-use prompt through a channel with the local dialog
staying live and the first answer winning. No runtime has it. The host already has a DIFFERENT remote
route — `RESPOND_TO_PERMISSION` is remote-eligible — so a channel relay would be a **second** authority
over the same decision, reachable by whoever is on a channel sender allowlist. The page also pins the
masking behaviour to CLI 2.1.234 while the bundle declares 2.1.233.

- **A — decline the channel route; keep `RESPOND_TO_PERMISSION` as the single remote authority** — buys:
  exactly one path that can answer a permission prompt, with one audit trail; no allowlist becomes a
  permission-granting credential; nothing is built against a page the bundle has not reached. — costs: a
  documented capability stays absent; a user away from the machine uses the existing remote route or
  nothing.
- **B — relay, behind a per-source opt-in that is off by default** — buys: the documented ergonomics, and
  the first-answer-wins race is the page's own design, so the semantics are specified rather than
  invented. — costs: a second authority over the safety decision; the opt-in becomes a security control
  that must be managed-policy-gated, audited and switch-reported on three runtimes; and it would be
  built against a contract our bundle is one patch version short of.

**Recommendation:** **A**, at least while the bundle declares 2.1.233. Re-ask when the bundle reaches
2.1.234 and the masking behaviour can be read rather than assumed.

**Parity direction.** **B closes the difference** with the page, uniformly (host-side). **A declares it**
and keeps one authority. Note that A is also the status quo on all three runtimes, so it opens no new
runtime-to-runtime divergence.

**Evidence:** `git grep -al 'channel/permission' -- packages apps` → 0 at `34be43fde` (control
`claude/channel` → 9); `protocol/channels.ts:44` `RESPOND_TO_PERMISSION`, in `REMOTE_ELIGIBLE_LIST`
`routing.ts:355` (set built `:626`); `2026-08-02-claude-doc-sweep-divergences.md:160` f137;
`claude-agent-sdk/package.json` `claudeCodeVersion 2.1.233`; page `channels-reference`.

### [host] Do we ship an environment-drafting assistant at all (`/auto-mode-setup`)?

**Closes:** Denominator A79 — `absent` on all three.

Claude ships `/auto-mode-setup`: it drafts a user's `autoMode` allow entries by reading the project, the
user's recent sessions and — optionally — their shell history and home-directory repositories, and it
writes `~/.claude/settings.json`. It is present in the vendored binary and unreachable from our app: a
CLI slash command whose surface we do not expose, writing a file that is not our config. Pi and codex
have nothing equivalent. So this is not a projection decision; it is whether we build the feature.

- **A — no; the managed block is written by an administrator** — buys: no new reads of personal data,
  no new writer of a permission-granting file, and the safety story stays "a human wrote these rules". —
  costs: users who want auto mode hand-write allow entries or, more likely, reach for a broad rule —
  which is the failure this feature exists to prevent.
- **B — yes, from project sources only (CLAUDE.md, README, git remotes, the repo's own scripts)** —
  buys: most of the drafting value from data the agent already reads in the ordinary course of work; the
  proposal is reviewable line by line before anything is written. — costs: a new writer of permission
  rules, which needs a managed-policy off switch and an audit line; and the draft's quality is the
  weakest part — a bad suggestion accepted is a broad allow rule with a friendly provenance.
- **C — B plus the optional personal sources (shell history, home-directory repositories)** — buys: the
  documented feature in full, and materially better drafts. — costs: the agent reads shell history — a
  category of personal data we read nowhere today; on a corporate deployment this is a policy question
  before it is a product one.

**Recommendation:** **B**, with the writer gated behind an explicit per-entry confirmation and a managed
off switch, and **C declined** until an operator asks for it in writing.

**Parity direction.** All three options are uniform across runtimes by construction (the host would own
the drafting and write our config, not `~/.claude/settings.json`), so **B and C close the difference with
the page; A declares it**. The claude-native command stays unreachable either way — worth one sentence in
the switch report.

**Evidence:** `auto-mode-config.md:179` names the project sources it reads; `git grep -aEin
'auto-mode-setup|autoModeSetup' -- packages apps` → 0 (the identifier appears only in
`scripts/claude-doc-anchors.tsv`); `grep -ac auto-mode-setup <vendored binary>` → 23 as the control that
the command exists natively.

### [host] A per-session scratch directory whose writes never raise a permission prompt

**Closes:** Denominator A81 — `absent` on all three.

`agent-view.md:704` documents a per-session scratch root with the load-bearing clause *"Writes here don't
prompt for permission"*, with `CLAUDE_JOB_DIR` as its companion at `:706`. The SDK **reads the variable**
— it is in the shipped bundle — so on claude this is configuration, not construction. Codex has no
equivalent in `packages/codex-protocol`; Pi's harness has no no-prompt scratch root either. Today a
session's temp files are gated one prompt at a time, and parallel sessions can collide on the same paths.

- **A — no; every write stays gated** — buys: exactly one rule — every write the model makes is seen by
  the gate — with no carve-out to reason about and no path an exfiltration could aim at without a
  prompt. — costs: a prompt per temp file, which trains users to allow broadly; and parallel sessions
  keep colliding on shared temp paths, which is a real defect and not only an annoyance.
- **B — yes; one host-owned directory per session, named in the gate** — buys: the collision goes away,
  the prompt noise goes away, and the exemption is a single host-owned path the gate itself names, so it
  is auditable and reportable; on claude it is the runtime's own mechanism (`CLAUDE_JOB_DIR`) rather
  than a host invention, which is native-first tier 1. — costs: a directory the model may write without
  ever being asked — it must be per session, outside the workspace, excluded from any read that feeds
  the model's context, and torn down with the session, or it becomes a staging area.

**Recommendation:** **B**, with the teardown and the "never re-read into context" property pinned by a
test, and one switch-report line saying codex and Pi get a host-supplied equivalent rather than a native
one.

**Parity direction.** **B closes the difference** and does it uniformly (host-owned path on all three,
using claude's own variable where it exists). **A leaves it absent everywhere**, which is at least
uniform — this is one of the few cells where the status quo is already honest.

**Evidence:** page `https://code.claude.com/docs/en/agent-view.md#where-state-is-stored`, table row at
`:704` ("Writes here don't prompt for permission"), companion `CLAUDE_JOB_DIR` at `:706`;
`CLAUDE_JOB_DIR` scores 0 files across `packages` + `apps` (2 repo-wide, both in
`docs/superpowers/specs`) while it IS in the shipped bundle — 2 hits across
`node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs` and `sdk.mjs`, positive control
`disableAllHooks` 2 on the same run.

### [host] Does the Windows build owe a WSL2 agent mode?

**Closes:** Denominator A87 — `absent` on all three.

On Windows the choice between running the agent natively and running it inside WSL2 decides **which
sandbox implementation protects the machine**: codex's own documentation says Windows-native uses the
Windows sandbox while WSL2 uses bwrap+seccomp. The selector is the ChatGPT desktop app's own UI, not a
config key — but the consequence is codex's. Our Windows path is committed to the native sandbox
(`[windows] sandbox = "unelevated"`), and Pi and claude have no WSL twin at all. The parked spike P3.7
("can our win32 build drive a codex/pi runtime inside WSL2") is EVIDENCE for this question, not an
answer to it, and it is blocked for want of a Windows host on any rig.

- **A — no; Windows-native only, stated beside the `unelevated` decision** — buys: one Windows sandbox
  story to maintain, test and report; no path mapping, fd-limit or bubblewrap-floor work; the decision
  is written where the next reader meets it. — costs: on Windows we ship the weaker of the two sandbox
  implementations codex supports, and a user who already works in WSL2 gets an agent that does not live
  where their code does.
- **B — a per-workspace selector, after P3.7 reports** — buys: the stronger sandbox for users who want
  it, and the agent runs where the workspace actually is. — costs: a second Windows runtime topology to
  build, test and support (path mapping, fd limits, the bubblewrap floor), on a platform with no rig
  today; and the sandbox implementation would then differ per workspace, which every switch-safety
  surface would have to learn.

**Recommendation:** **A**, until a deployment asks for B in writing. Unpark P3.7 only when a Windows rig
exists — until then B cannot be costed, and a decision taken without it would be invented.

**Parity direction.** **B closes the difference** with what codex's own host offers; **A declares it**
beside the `unelevated` decision. Neither changes a Pi/claude difference — they have no WSL concept.

**Evidence:** no WSL agent-mode selector found — `apps/electron/scripts/build-win.ps1` has no WSL branch
and the codex spawn is a direct child (`packages/codex-agent-server/src/runtime-manager.ts`); the Windows
sandbox we DO configure is the native one, `packages/server-core/src/pi-harness/isolation/windows.ts:118-120`
writes `[windows] sandbox = "unelevated"`; page `agent-approvals-security.md` §OS-level sandbox (weak
tier); plan `P3.7` (⬜, PARKED, plan line 3176 — "no Windows host on any rig; WIN-1 in the CDP table
waits for one"), spike defined at plan `:1973-1975`.

### B#0

# Owner questions — denominator group B ("What an organisation can actually enforce"), slice 1 of 1

Four new questions, one already asked. Each names the denominator ids it closes and which option closes
the runtime difference. Checked against the headings of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and
`docs/superpowers/specs/2026-09-04-owner-sitting.md` before writing — none of the four is asked there.

---

### [host] Deploy a fixed MCP server set users cannot add to — or restate the 2026-07-29 ruling that we will not

Closes: **B12** (`managed-mcp` — deploy a fixed set of MCP servers users cannot add to, modify or bypass,
including disabling MCP entirely with an empty server map). Verdicts absent ×3, klass OWNER, size L.

already_ruled: `docs/superpowers/specs/2026-07-29-deviation-audit.md:193` puts `managed-mcp.json` delivery
out of scope ("Record as C"). The ruling has never been restated in the out-of-scope register, so the
capability keeps being re-found as a gap — this question asks whether to confirm it or reopen it.

What exists at HEAD: `managed-mcp.json` → **0** tracked files (controls on the same rig: `allowedChannelServers`
→ 6, `strictPluginOnlyCustomization` → 13). Our gate `isManagedMcpServerAllowed` (imported `storage-runtime.ts:22`,
called `:1085`, `:1179`, `:1209`, `:1224`) can FILTER what a user configured; it cannot DEPLOY a server, and
there is no empty-map "MCP off" pole. Native-first: claude reads `managed-mcp.json` itself from the three
documented system paths, so a projected file would be honoured natively by that runtime alone; Pi and codex
would need the host to supply the set.

- **Confirm the ruling and restate it in the out-of-scope register** — buys: no second config format enters the tree for a fleet that does not deploy one; the absence stops being re-found by every sweep; zero code. — costs: an organisation can never say *these servers and no others*, only *not those*; the empty-map "turn MCP off entirely" pole stays unreachable; claude keeps a native mechanism we deliberately do not feed.
- **Project `managed-mcp.json` for claude only** — buys: the one runtime that reads it natively gets the full documented capability for a small, well-bounded write. — costs: a NEW silent divergence of exactly the class this ledger exists to catch — the same policy deploys servers on claude and does nothing on Pi or codex — unless a switch cost is written in the same commit.
- **Host-side deployed server set for all three** — buys: the capability lands uniformly, one seam, and the empty-map pole becomes expressible on every runtime. — costs: L; a second config format and its precedence against the user's own MCP config, the approval surface, and the credential story for a deployed server.

Recommendation: **confirm the ruling and restate it in the register**, per the source slice's own
recommendation — the alternative imports a second config format for a fleet that does not deploy it.
Parity direction: option 3 is the only one that closes the difference; option 2 widens it.

---

### [host] Should a managed plugin mandate ACQUIRE the plugin, or stay the report-only no-op it is today?

Closes: **B13** (`51 discover-plugins` — have an administrator's plugin actually installed by policy, the
"managed" install scope). Verdicts absent ×3, klass OWNER, size L.

What exists at HEAD, asked and answered in-tree: managed `enabledPlugins` is read by the ACTIVATION overlay
only; nothing installs. `packages/shared/src/plugins/mandated-plugins.ts:9-19` states it verbatim — "Nothing
installs it… The mandate is a silent no-op". It is not fully silent: `config-doctor.ts:54-55,165,416,604-605`
renders a "Force-enabled plugins:" section and `:640` folds `hasUnfulfilledPluginMandate` into the doctor's
verdict, wired from `apps/cli/src/doctor.ts:36-51`. The runtime that COULD install (claude) is fed
`plugins: []`. Page `51 discover-plugins` line 302. Scope: an organisation control that silently stops
controlling — the administrator states the plugin runs on the fleet and it does not.

- **Report-only, as today** — buys: nothing is acquired or executed from policy; the no-op already surfaces in the doctor, so the honesty surface exists; zero code. — costs: the documented "managed" install scope is simply absent; an administrator's mandate is advisory on every runtime, and the report reaches only the CLI doctor, which the desktop app has no route to.
- **Acquire at boot from a delivered marketplace** — buys: the mandate does what the page says; an organisation can guarantee a plugin is present, not merely enabled where already installed. — costs: unattended execution from policy — the host fetches and installs code because a file said so, at boot, before any user is present; it needs the delivered-marketplace trust story, a failure posture when the fetch fails, and it makes the managed tier a code-delivery channel.

Recommendation: **(a) report-only**, per the source slice — (b) is unattended execution from policy.
Parity direction: neither option creates a runtime difference (the mandate is host-side and uniform);
option (a)'s residue is a BUILDABLE S — carry the doctor's "Force-enabled plugins" verdict onto a
desktop-reachable surface, since today the only reach is CLI-only.

---

### [host] Does the built-in browser owe an administrator a graduated policy, or stay the all-or-nothing switch?

Closes: **B16** (`desktop (#22)` + `row 18 · browser` — let an administrator express which origins the pane
may reach, whether the agent's tools act on external pages, and whether upload and download are allowed).
Verdicts partial ×3, klass OWNER, size L.

Two reader premises were measured WRONG and are corrected here before the options: (1) a tools-off tier
ALREADY EXISTS host-side for all three — `getBrowserToolEnabled()` (`config/storage.ts:1338`, default true at
`:131`/`:270`) gates `browser_tool` out of the session tool defs (`agent/session-scoped-tools.ts:345-348`,
`agent/pi-agent.ts:2555`), surfaced at `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx` symbol `handleBrowserToolEnabledChange` (re-anchored by symbol 2026-10-16 (UB15.5): the page moved onto the SettingsPage column and its line anchor went stale); (2) "the managed-settings surface carries no
browser keys" is FALSE — `packages/shared/src/agent/claude-managed-settings.ts` symbol `disableInAppBrowser` defines it as a
`host-gate` key whose enforced composition feeds the pane gate and whose startup pass CLOSES an already-open
pane (P3.257(b), measured 2026-09-03), with the headless host covered by `NullBrowserPaneManager`. So this
extends a live mechanism rather than adding one. What is genuinely absent is GRANULARITY: no origin allowlist,
upload gate or download gate in `browser-pane-manager.ts` (the shared partition and annotation caps around
`:1113-1157` carry no policy layer), and no admin key feeding the existing tools-off gate.
`config/managed-in-app-browser.ts:26-40` already weighed three postures and rejected an allowlist "because
there is nothing to read it from". Codex publishes its own `[features] in_app_browser` boolean with no consumer
in the binary. Verdicts moved absent → partial on both slices.

- **Keep the binary switch; state the codex asymmetry** — buys: nothing new to maintain; the existing `disableInAppBrowser` key is real and enforced. — costs: an administrator can only take the browser away wholesale; the graduated policy an organisation would actually write cannot be expressed; codex's consumer-less `in_app_browser` boolean stays a key that reads as a control and is none.
- **Add an admin key feeding the existing tools-off gate** — buys: the smallest honest step — an administrator can leave the pane for the human and take it from the agent, reusing a gate that already works on all three; S–M, not L. — costs: still no origin concept, so "the agent may browse our intranet and nothing else" remains unsayable.
- **Origin allow/deny for the pane** — buys: the tier an organisation behind corporate egress controls actually asks for; a real answer to "which origins may this agent reach". — costs: an origin concept the pane does not have today, and a policy layer in `browser-pane-manager.ts`; every redirect, iframe and download URL needs a rule.
- **Origins plus upload and download gates** — buys: the full documented posture — egress, ingress and exfiltration each separately expressible. — costs: L, and the upload/download half touches the file-transfer path as well as the pane.

Recommendation: **(c) origin allow/deny**, per the `row 18 · browser` slice; the `desktop (#22)` slice's own
recommendation, **(b) an admin key on the existing tools-off gate**, is the cheaper first step and is
strictly contained by (c) — take (b) now and (c) next if the origin concept is wanted.
Parity direction: (b) and (c) are host-side and close the difference on all three at once; the residual
codex asymmetry (its own consumer-less `in_app_browser`) must be named in the switch report either way.

---

### [host] Reopen R50's delivery channels — MDM plist and HKLM — or document file-plus-drop-in as the only channel?

Closes: **B17** (`admin-setup`, `managed-settings` — deliver managed policy through OS policy channels that
resist tampering). Verdicts absent ×3, klass OWNER, size L.

already_ruled, VERBATIM: `docs/superpowers/plans/2026-08-04-doc-sweep-parity-wave.md:2853` — R50
`managed-policy-sources`, "DROPPED, owner decision 2026-08-08", "there are no third-party administrators".
Also `docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:480` — "only 2 of the 4 documented
delivery mechanisms exist". This question exists only because the ruling predates the ledger and the sweep
keeps re-finding the capability; answering it once closes B17 permanently either way.

Verified at HEAD `34be43fde`: our managed tier is file + server only, at Nessy paths
(`/Library/Application Support/Nessy`, `C:\ProgramData\Nessy`) — `pi-harness/isolation.ts:118` and
`isolation/self-config-deny.ts:105-112` (`managed-policy.json` + `managed-policy.d/`),
`managed-composition.ts:402-428` composing exactly two sources into winner `delivered`/`file`/`none`;
`managed-system-paths.ts:110-120` names the `HKLM\SOFTWARE\Policies` route as the native-first candidate NOT
taken. Probes: `com.anthropic.claudecode` 0, `plutil` 0, `managedPreferences` 0, `winreg` 0; control `MDM`
→ 17, all doc-comments. Native mechanisms that exist and we do not use: the vendored SDK reads MDM/HKLM/HKCU
itself for the child it spawns; codex has an MDM `requirements.toml` entry upstream that this host never
writes or reads; Pi has none — the host is its only policy reader. Distinct from B10, which is our OWN file
tier being inert on win32.

- **Confirm R50: document file + drop-in as the only channel** — buys: the ruling is restated where sweeps read it, the absence stops being re-found, zero code. — costs: our policy file is user-writable in a way an OS policy channel is not, so a determined user on their own machine can defeat the managed tier; three of four documented channels stay absent.
- **Add a macOS configuration-profile reader** — buys: a tamper-resistant channel on the platform this product is developed and demoed on; aligns with what the vendored SDK already reads for its own child. — costs: a plist reader plus its precedence against the two existing sources; an MDM to test against, which no rig has.
- **Add an HKLM policy reader on Windows** — buys: the channel a Windows fleet actually uses, and it is already named in-tree as the untaken candidate. — costs: needs the Windows evidence day that P3.7 parks for want of a Windows host; couples to B10, which must land first or the reader has nothing to enforce.

Recommendation: **(a) confirm R50 and document the two channels**, then **(c) HKLM** if a Windows fleet ever
becomes real — that is the source slice's own order.
Parity direction: (b) and (c) each close the difference on ONE platform only; option (a) closes nothing and
makes the limit honest, which is the correct trade while "there are no third-party administrators" holds.

---

### C#0

# Denominator group C — owner questions (slice 1 of 1, entries 1–25 of 25)

Group: `### C. What leaves the machine, and corporate deployment`
(`docs/superpowers/specs/2026-09-05-denominator-gaps.md:166`). Three new questions; five entries
already asked or already ruled, listed at the end.

### [host] May an operator forbid personal-key and BYO authentication and require the gateway sign-in?

*(closes denominator **C10** — `admin-setup`; Pi `absent`, claude `absent`, codex `absent`)*

The vendor ships `forceLoginMethod` / `forceLoginOrgUUID` and the SDK managed tier that would carry
them is live at HEAD (`packages/shared/src/agent/claude-agent.ts` symbol `ClaudeAgent` calls
`buildClaudeManagedSettingsOptions`, so out-of-scope O8's *"no production caller"* is STALE). We carry
neither: `git grep -ail -F forceLoginMethod` over `:(glob)packages/**` `:(glob)apps/**` → 0 files;
`forceLoginOrgUUID` → 2 files, both non-production
(`packages/shared/src/agent/claude-managed-settings.ts` symbol `forceLoginOrgUUID` prose and
`managed-policy.test.ts:381-384`, which pins it as a key-we-do-not-carry producing a named DROP).
Bundle probe `forceLoginMethod` → 2 (controls `Cookie` 5, `git-subdir` 4). Pi and codex have no native
login-method gate; the host owns credential selection for all three.

- **A. Host-side enforcement — a managed key that hides and refuses every non-gateway connection card** — buys: real enforcement on all three runtimes from one seam, which is what the corporate deployment the page is written for actually asks for; the refusal is legible at the card, not at turn time — costs: removes the BYO escape hatch an operator today relies on for an outage or a model the gateway does not serve, and every support path that starts *"paste your own key"* stops working.
- **B. Disclosure only — one operator-visible line naming the policy, no refusal** — buys: nothing breaks, the divergence becomes honest, and it is the smallest thing that can ship this quarter — costs: it is not a control, so an organisation that believes it has forbidden personal keys has not; a control that does not control is the defect class this fork is closing.
- **C. Project the vendor's own `forceLoginMethod` to the claude child and stop there** — buys: native-first step 1, configuration rather than construction, and the vendor enforces it inside its own binary — costs: it enforces on ONE of three runtimes; a user switches to Pi or codex and the policy silently evaporates, which manufactures exactly the silent divergence the host exists to prevent.

Recommendation: **A**, with B's line as its refusal text. C only as a belt on top of A, never alone.

Parity direction: **A closes the difference on all three runtimes.** B keeps the difference and makes
it honest. **C closes it on claude only and opens a new one.**

### [codex] May a codex connection use the operator's own AWS Bedrock account, and leave the Nestor gateway to do it?

*(closes denominator **C15** — `amazon-bedrock`; Pi `have`, claude `have`, codex `absent`)*

Codex HAS it natively: `model_provider = "amazon-bedrock"` in `config.toml`, credentials from
`AWS_BEARER_TOKEN_BEDROCK` or the AWS SDK chain. Only our pin stands between them —
`packages/codex-responses-adapter/src/config-writer.ts:797-801` always writes our loopback as
`model_provider`. Pi reaches Bedrock at `packages/shared/src/agent/pi-agent.ts` symbol `buildAwsEnv`
(`piAuthProvider === 'amazon-bedrock'`, catalogue in `config/llm-connections.ts` +
`config/bedrock-model-ids.ts`); claude through
`packages/shared/src/config/claude-provider-routing-env.ts:54-60`. **Correction the answer turns on:**
`AWS_BEARER_TOKEN_BEDROCK` does NOT score 0 — P3.346 exists precisely because the boot reset must NOT
delete it (`packages/shared/src/config/__tests__/boot-auth-env-reset.test.ts:9,73`), and every
non-Claude child is built by spreading `process.env`
(`packages/codex-agent-server/src/runtime-manager.ts`), **so an ambient Bedrock credential already
reaches the codex child today** — the question is whether anything may act on it.

- **a. No — keep the loopback pin, and say so** — buys: preserves C5's guarantee that no ambient cloud credential can route a session away from the configured gateway, on the runtime where that guarantee is currently strongest — costs: the codex↔Pi/claude difference stays, and it stays for a capability the runtime already has; a Bedrock-only organisation cannot use codex at all.
- **b. An explicit BYO Bedrock card only — the connection declares it, the ambient chain never decides** — buys: closes the difference for the user who asks for it, through codex's own documented mechanism (native-first step 1), while an ambient `AWS_*` in someone's shell still cannot reroute a pinned session — costs: one more provider card, its catalogue and its credential surface; the card's existence is a disclosure an operator must be able to switch off.
- **c. Also honour the ambient AWS credential chain, as codex's own default does** — buys: works with an already-configured corporate AWS profile, no new card, no new credential surface — costs: it is exactly the reroute C5 was built to refuse, and it would land on the runtime whose child already inherits the variable, i.e. it ships silently.

Recommendation: **b**.

Parity direction: **b closes the Pi/claude↔codex difference under an explicit user act.** c closes it
implicitly and regresses C5. a keeps it and makes it honest.

### [host] Should Nessy Desktop offer projects on remote SSH hosts at all?

*(closes denominator **C17** — `remote-connections`; Pi `absent`, claude `absent`, codex `absent`)*

Codex publishes an SSH story, evidence **WEAK — page only, intent not behaviour**:
`learn.chatgpt.com/docs/remote-connections.md#connect-to-an-ssh-host` reads aliases from `~/.ssh/config` and starts `codex`
on the remote PATH, and `#hand-off-a-chat-between-hosts` covers the handoff. Not found in
`github.com/openai/codex` at `rust-v0.148.0`; the shipped binary was not probed; no handoff field
exists in `packages/codex-protocol/generated/v2`. Our side is local-only by construction: `ssh`
(case-insensitive) in `packages/codex-agent-server/src/` = 0 files against the positive control
`stdio` = 9 files, and `app-server-client.ts:1-2` describes itself as *"Minimal JSON-RPC 2.0 client
over the codex app-server's newline-delimited stdio transport"*. The same-host handoff machinery we DO
have is `packages/server-core/src/sessions/runtime-handoff.ts` (`packages/server-core/src/sessions/SessionManager.ts` symbol `buildRuntimeHandoffPayload`) —
**not** `base-agent.ts:422`, which only names it in a comment.

- **A. Stay local-only and record the divergence (~5 lines)** — buys: honest today, costs nothing, and does not build a product surface on a page-only claim we have not been able to confirm in codex's own source — costs: a real capability of one runtime stays unavailable on all three, and the disclosure will read as an excuse to anyone who has used it in codex's own CLI.
- **B. Build SSH projects on our own websocket server, uniformly for all three runtimes** — buys: remote work on every runtime rather than one, through the transport we already own and can audit; the handoff reuses `runtime-handoff.ts` — costs: a plan, not a lane — a remote filesystem, a remote shell, credential handling on the far side, and every permission floor in this product re-derived for a machine the user is not sitting at.

Recommendation: **A** — and, before B is ever costed, probe the shipped codex binary so the option is
built on measured behaviour rather than a Beta-marked page.

Parity direction: **B closes the difference on all three runtimes at once** (the host seam, native-first
step 2). A keeps it and makes it HONEST, which is the host's job when step 1 and step 2 both cost more
than the capability is worth today.

### D#0

# Owner questions — denominator group D, slice 1 of 1 (entries D5–D7)

**No new owner question in this slice.** All three entries are `BUILDABLE S` in the denominator table and were
placed as tracker rows in `rows-D-0.md`: D5 and D6 together in one row (one file, one lane), D7 in its own.
Nothing here changes a product posture that is not already ruled or already asked.

### E#0

# Owner questions — ledger group E (The context window), entries E6–E11

### [host] Reopening a long, stale conversation: load it as-is, always compact, or ask once and remember

Closes **Denominator E8** (`absent` on pi, claude and codex alike — it is a host dialog over our own
transcript, not a runtime capability). The compaction it would invoke already exists on all three
(E10, `contextUsage.compact.manual`), so this decision is only about the TRIGGER and the DEFAULT.
Upstream gates the prompt on a Pro/Max plan plus inactivity and conversation size; we have no such
plan, so the staleness/size trigger is ours to choose as well as the default.

- **A — always load as-is** — buys: faithful, nothing is ever silently dropped, no new dialog, no new setting. — costs: the whole history is re-sent on every later request, at a per-request cost that scales with the conversation's size; the user pays it without ever being offered the alternative.
- **B — always compact on reopen** — buys: cheapest reopen, one code path, no dialog. — costs: lossy, and the user is never told what was dropped; a reopen becomes destructive, and there is no way back to the full transcript.
- **C — ask once and remember the answer, as the page does** — buys: the only option whose divergence is VISIBLE at the moment the cost is incurred; the answer is remembered, so it is one dialog per conversation, not per reopen. — costs: one extra dialog; the operator must pick the staleness/size trigger we do not inherit from a plan tier, and that trigger becomes a setting we own.

Recommendation: **C**. A and B both make a cost decision silently on the user's behalf, and this is a
user-visible policy with a real per-request bill attached. **Parity direction:** C closes the
difference — E8 is `absent` on all three runtimes, so any option makes the three uniform, but only C
makes the host's residual choice (the trigger) honest instead of hidden; A and B leave the product
diverging from the documented upstream behaviour with nothing on screen to say so.

### F#0

# Owner questions — ledger group F (Sessions, checkpoints, recovery), entries F9–F48

### [host] Deleting all local state for a project — ours only, ours and the runtime's, or neither

Closes **Denominator F17** (`absent` on pi, claude and codex alike — the session store, the task store
and the debug logs are all ours, so no runtime offers a purge a host could call). The per-SESSION delete
already exists (`apps/cli/src/index.ts` symbol `cmdSessionDelete`, the positive control); what has no symbol anywhere is a
project-scoped one — `purgeProject` and `deleteWorkspaceData` score 0 hits over `packages/shared/src`,
`packages/server-core/src` and `apps/electron/src`, the only `purge*` symbols being plugin- and
capability-scoped (`capabilities/policy-store.ts:241`, `trust-store.ts:164`,
`plugins/mcp-credentials.ts:91`). The complication is that codex writes its own `~/.codex` history, so
any purge must name it or exclude it — silence is the one answer that cannot be defended.
Page `cli-reference.md`.

- **A — purge our own state and SAY codex's `~/.codex` history is untouched** — buys: one uniform command across all three runtimes, deleting exactly what this product wrote — transcripts, task lists, debug logs, file-edit history, prompt history and the config entry — with the residue named on screen so the user knows where to look next. — costs: the user must delete a sibling tool's data themselves; the command is honest but not complete.
- **B — purge ours and the runtime's, including `~/.codex`** — buys: one gesture really does leave nothing behind, which is what a user asking to delete a project means. — costs: we delete data written by a tool the user may also drive outside Nessy, from a command whose name says "project"; irreversible, cross-application, and the blast radius is not ours to bound. Our own codex containment argues against it — `CODEX_HOME` is `mkdtempSync`ed and `rmSync`ed per session, so the durable `~/.codex` we would be deleting is by definition the user's OTHER codex, not ours.
- **C — no purge; keep per-session delete and document the divergence** — buys: nothing new to get wrong, no destructive command to mis-aim. — costs: the documented capability stays absent on all three, and a user offboarding a project has no supported route at all; the gap stays invisible.

Recommendation: **A**. Deleting a sibling tool's data silently is not a posture to take, and B is the
only option that does it. **Parity direction:** the cell is `absent` on all three, so A and B both make
the three uniform — A does it while keeping the residue HONEST, which is the standing host rule; C
leaves the difference from the documented product in place with nothing on screen to say so.

### [host] Never persisting a transcript at all, or leaving the retention cap as the whole answer

Closes **Denominator F18** (`partial` on pi, claude and codex — verdicts corrected: the reader's "no
user-facing off switch or cap" is half REFUTED, because the cap ships and sweeps; and the codex cell
moves `n/a` → `partial` because the transcript this capability would turn off is the HOST's, written
identically on the codex arm — only codex's OWN `[history]` file is `n/a`, since our `CODEX_HOME` dies
with the session by the Dev-11 ruling). So the question is narrower than it looks: a user-settable,
admin-pinnable retention CAP already exists and sweeps transcripts; what has no equivalent is the
**never-persist** direction. The machine for it exists too — the ephemeral session flag gates every
persist call (see the F9/F10 row) — so this is a posture decision, not a build estimate.
Page `config-advanced (row 29)`; codex's own key is `history` / `history.max_bytes`
(`codex-rs/config/src/config_toml.rs:320`, strong tier), and `git grep -a '\[history\]' -- packages apps` → 0.

- **A — offer a never-persist mode as a first-class setting** — buys: the documented capability, reachable by a user who does not want finished sessions on disk at all; it rides the ephemeral machine that already exists, so it is small. — costs: a session that persists nothing cannot be resumed, rewound or searched, and the user meets that only after the fact unless the mode says so up front; every recovery feature in this group silently becomes absent inside it.
- **B — leave the retention cap as the whole answer, and say so** — buys: no new mode, no new failure surface; the cap is already user-settable and admin-pinnable and already deletes transcripts, checkpoints, plans and the vendor's own tree. — costs: the minimum retention is not zero (`setRetentionDays` rejects 0), so "never on disk" stays unreachable; a user with that requirement has no answer and the divergence stays unwritten.
- **C — allow the cap to reach zero, so the sweep deletes on close** — buys: one mechanism, one setting, no new mode; the shortest path from what ships today to what the page describes. — costs: it is a false never-persist — the transcript IS written and then deleted, so it exists on disk for the life of the session, which is exactly the property a user asking for this is trying to avoid; and it would be indistinguishable, in the setting's own words, from A.

Recommendation: **A**, with the mode stating its cost when it is entered. **Parity direction:** F18 is
`partial` on all three because the cap is host-side and uniform, so any option keeps the three uniform;
A is the only one that closes the difference from the documented capability, and C closes it in name
while leaving the disk write in place, which is the shape this fork's largest defect class already has.

### [host] Waiting out a usage limit: wait where a reset is published, retry on a fixed interval, or surface it and stop

Closes **Denominator F21** (`absent` on pi, claude and codex — no arm waits, on any runtime;
`autoContinueAtUsageLimit` → 0 files). The measurement that shapes the options: **a reset timestamp
EXISTS on two of the three arms and neither drives a wait.** Claude's `rate_limit_event` carries
`resetsAt` and we already normalize and print it (`backend/claude/event-adapter.ts:524`, `:1974-1984`
→ *" Resets <date>."*). Codex's `RateLimitWindow.resetsAt` exists but arrives on
`account/rateLimits/updated`, which sits on the deliberate unread list
(`codex-notification-families.ts:205`). The Nessy gateway is not verified to publish one at all.
Page `interactive-mode.md`.

- **A — wait only where a reset timestamp is published, and say so where it is not** — buys: the session resumes by itself at a time the SERVER named, so the wait is bounded by a fact rather than a guess; on the gateway arm the user is told plainly that no reset was published and the turn stops. — costs: behaviour differs by connection, which must be stated at the switch; and the codex arm needs `account/rateLimits/updated` taken off the unread list, which is a small scope increase with its own verdict.
- **B — fixed-interval retry everywhere** — buys: one code path, uniform on all three, no dependency on a field the server may not send. — costs: it invents a reset the server never promised — the retry either fires too early and burns the limit again, or too late and wastes the user's time; and on the two arms where a real timestamp EXISTS it deliberately ignores it.
- **C — leave it, and surface the limit honestly** — buys: nothing new to get wrong; the limit and its reset time are already printed on the claude arm. — costs: an unattended session dies at the limit and the work is lost, which is the failure this capability exists to prevent; the gap stays absent on all three.

Recommendation: **A**. B invents a reset the server never promised, which is the failure mode the
read-don't-invent rule is written for. **Parity direction:** A leaves a REPORTED divergence (the
gateway arm waits for nothing and says so) rather than a silent one, which is the honest-seam rule; B
is uniform and wrong; C closes nothing.

### [host] A runtime-blind multi-session screen — build it, or keep the divergence

Closes **Denominator F27** (`absent` on pi, claude and codex). **Read this before answering: the
standing ruling everyone reaches for is NOT about this cell.** P4.7 and DR-1 (plan `:3550` and `:1147`)
rule on the Pi runtime inspector over `getPiHarnessRuntime` — *"DO NOT BUILD … a panel absent on two
runtimes of three reads to a user as claude is worse"* — a **Pi-only** surface. A runtime-blind
multi-session screen over the host's own session records is a different proposition and is **unruled**.
The page-level divergence is already recorded
(`docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:461`, row 52: *"`claude agents`, the
per-user supervisor … have no counterpart in this fork"*). Native mechanism, asked: claude's supervisor
and `claude agents` are in the shipped bundle (`CLAUDE_JOB_DIR` and `bgIsolation` both probe 2 hits) but
are a **CLI-process** feature, not an SDK surface a host can drive; codex has none; Pi's is the runtime
snapshot, Pi-only by construction. So there is no native mechanism on any of the three, and the only
seam is the host's own session records — which every runtime writes identically.
Page `agent-view.md`.

- **A — no screen; keep the divergence and record it** — buys: no new surface to keep honest, no Phase-4 design cycle, and the recorded page-level divergence stands as the answer. — costs: unattended work stays silently blocked — a session waiting on a permission request is invisible until someone opens it — and every downstream capability in this group (row summaries, background jobs, peek-and-reply at scale) has nowhere to live.
- **B — build it host-side, runtime-blind, over the session records** — buys: dispatch and manage many sessions from one screen with what each is doing, which need input, which finished or failed, plus peek, attach, stop, pin, rename and reorder — identical on all three runtimes by construction, because the data is ours; it is the ONE surface in this group that cannot manufacture a Pi-only divergence. — costs: an L build with its own i18n, playground states and Phase-4 design pass; and it must refuse to render any per-runtime field, or it becomes the thing P4.7 declined.

Recommendation: **B**. The reason P4.7 declined its panel — that a Pi-only surface manufactures the
divergence this wave exists to close — argues FOR this one, because a screen over host records is
uniform by construction. **Parity direction:** the cell is `absent` on all three, so both options keep
the three uniform; only B closes the difference from the documented product, and it is a precondition
for the smallest honest piece already queued as a row (peek-and-reply over the session list).

### [host] One-line session summaries — derive them free, or spend a model turn

Closes **Denominator F29** (`partial` on pi, claude and codex — auto-TITLING already exists and is
shared, `sessionTitle`/`generateTitle`/`autoTitle` resolving in 28 files across `packages` + `apps`
with a test behind it; what does not exist is a per-turn status summariser or any mini-model routing
for one). **Reclassified from BUILDABLE by the sweep, and the reason is the whole question: a per-turn
model request on the user's quota is an operator cost, not an implementation detail.** Native
mechanism, asked: claude's SDK does this for its OWN agent view and that view is unreachable from a
hosted session; codex has none; Pi has none; the host's nearest asset is the mini-model concept
(`packages/pi-agent-server/src/pick-mini-model.ts`), which is where either answer would attach. **The
page's own fallback rule is exactly our situation and has no reader:** `agent-view.md:146` — *"On a
third-party provider or gateway with no Haiku-class model configured, the request uses the session's
main model instead"* — so on the Nessy gateway the documented behaviour is to bill the MAIN model for
every row summary. Page `https://code.claude.com/docs/en/agent-view.md#row-summaries`.

- **A — derive the row from the session's own output, with no extra model call** — buys: free, instant, no quota consumed, no new model routing, and it works identically on all three runtimes; the row is always in step with what the session actually last said. — costs: the line is a truncation or a heuristic rather than a summary, so it will read worse than the documented feature on long or tool-heavy turns.
- **B — spend the connection's mini model on each row** — buys: the documented capability, a real one-line summary of what the session is doing. — costs: a recurring per-turn charge on the user's quota that they did not ask for and cannot see, and on the gateway — our default connection — the page's own fallback says it lands on the MAIN model, which is the expensive one; it also needs the mini-model routing this product does not have for this purpose.

Recommendation: **A** for now. It is free, uniform and honest, and it leaves B reachable as a setting
later if the summaries prove worth paying for. **Parity direction:** the cell is `partial` on all three
and both options keep it uniform; A closes the visible gap at zero operator cost, B closes it fully at
a cost the user cannot see — and an invisible recurring charge is the posture this product has
elsewhere refused.

### [host] Background auto-commit before an unattended session finishes

→ sitting §1.7

(Closes **Denominator F30**, `absent` on pi, claude and codex. Two things this slice ADDS to the
sitting entry rather than restating it: `agent-view.md:501` is a SECOND published place for the
preserve-before-finish clause, which strengthens option (B) there; and ledger **I4** is the adjacent
row to close in the same pass — I4 reads `absent ʰ / absent ˢ / absent ˢ`, DEFECT, *"our cleanup is
age-based and removes without snapshotting. Data-loss-adjacent"* — the same data-loss risk from the
HOST side, where §1.7 decides the MODEL side. Plan scope: DR-2, plan `:1145`.)

### [host] A user-typed background shell job, outside any session

Closes **Denominator F31** (`absent` on pi, claude and codex). Native mechanism, asked and answered:
**none on any of the three** — this is a host job runner, not a runtime feature; codex and the claude
SDK both expose shell execution only as an agent TOOL CALL, which is the opposite of what the page
describes (a row you watch and attach to, with no model in the loop). The machinery exists on one
runtime only and is not general: `packages/core/src/types/pi-harness-runtime.ts:28` types a process row
(`'running'`, `'exited'`, `'stopped'`, `'timed-out'`, `'lost'`) fed by the Pi process supervisor. The
CLI has no such flag either — `--bg` scores FIVE files across `packages` + `apps` (re-measured
2026-09-10, W9-cj: 6 lines over 5 files) and every hit is a COMMENT quoting the claude SDK's own
agent-view sentence: `apps/cli/src/index.ts` symbol `parseArgs`, plus
`packages/server-core/src/pi-harness/child-session-service.ts` symbol `disableAgentView`
and its test, `packages/shared/src/agent/pi-harness/managed-policy.ts` symbol `disableAgentView`, and
`packages/pi-agent-server/src/orchestrator/spawner-agent-view-disabled.test.ts`. `claude --exec` has
no host caller. The page-level absence is already
recorded at `docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md:461`.
Page `https://code.claude.com/docs/en/agent-view.md#run-a-shell-command`.

- **A — no; commands stay gated tool calls** — buys: every shell execution in this product keeps passing the permission gate, the breakers and the audit path, with exactly one route in and one place to reason about it. — costs: the documented capability stays absent on all three, and a user who wants to watch a build beside their session has no route but a terminal outside the app.
- **B — yes, host-side over the Pi supervisor rows** — buys: the documented row-you-can-watch, reusing a supervisor that already tracks state, output and termination. — costs: **it is a shell-execution path the permission gate does not see** — the gate is built for tool calls, and a user-typed job arrives beside it; the supervisor is Pi-shaped, so making it runtime-blind is part of the build; and it overlaps J9 (an interactive terminal in the chat), which would then be the second uncovered execution route.

Recommendation: **A**, unless J9 is taken — if an interactive terminal is built, the gate question is
answered there and B becomes a small addition to it rather than a new hole. **Parity direction:** the
cell is `absent` on all three and stays uniform either way; A leaves a documented gap with a recorded
reason, B closes it at the cost of a second execution route the safety floor was not designed for, and
that trade is the owner's, not a lane's.

### [host] Prompt history across sessions — reverse a recorded privacy choice, or document the divergence

Closes **Denominator F36** (`absent` on pi, claude and codex — host-side and runtime-independent).
**The measurement is already done and recorded, so this is only a posture:** there is no cross-session
prompt history at all; the composer's history is an in-memory ref whose only writer is the double-Esc
clear, and it is dropped on every session switch **by design, with the reason written at the site**.
`apps/electron/src/renderer/components/app-shell/input/double-escape.ts:59-71` — verbatim: *"`promptHistory`,
`inputHistory`, `recentPrompts` and an `ArrowUp` recall in the composer all measured ZERO before this
row (positive control: `ArrowUp` itself is present) … Submitted prompts are NOT recorded, it is
in-memory … dropped on a session switch"*; the drop and its leak reason are at
`apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` symbol `FreeFormInput`. So persisting prompts per directory **reverses a recorded privacy
choice**, which is why this is not a lane's call. Page `interactive-mode.md`.

- **A — keep it in-memory and per session** — buys: today's behaviour, the recorded privacy choice intact, nothing new on disk. — costs: the documented capability stays absent, and the absence is undocumented too — a user pressing ArrowUp after a session switch simply gets nothing, with no explanation.
- **B — persist prompts per directory, honouring `NESSY_SKIP_PROMPT_HISTORY`** — buys: the documented capability, including search by scope, on all three runtimes at once. — costs: it writes what the user typed to disk, per project, reversing a choice this repo made deliberately; and it inherits the F9 defect until that row lands, because the opt-out env spelling currently does nothing in the desktop — so B shipped first would be a persistence with a **broken off switch**.
- **C — document the divergence, and leave the behaviour** — buys: the honest surface at near-zero cost; the absence stops reading as a bug. — costs: still absent; a user who wants the feature is told no, in writing.

Recommendation: **C first, then B** — say what the product does now, and if prompt history is wanted,
land it only AFTER the F9 row makes `NESSY_SKIP_PROMPT_HISTORY` real, so the opt-out exists before the
data does. **Parity direction:** `absent` on all three and uniform under every option; C makes the
difference from the documented product HONEST, B closes it — and B without F9 would close it while
silently removing the user's only way out, which is worse than the gap.

### G#0

# Denominator group G (hooks and automation) — owner questions, slice 1 of 1

One question, closing one ledger id (G15). The other nineteen entries are tracker rows in
`rows-G-0.md` and need no owner input.

### [host] How does a user's own environment reach a host-run command hook?

Closes: **denominator G15** (pi `absent`, claude `partial`, codex `absent`) — "Turn one review
layer off, or choose the review model, with the security plugin's own environment variables —
`ENABLE_PATTERN_RULES`, `ENABLE_STOP_REVIEW`, `ENABLE_COMMIT_REVIEW`,
`ENABLE_CODE_SECURITY_REVIEW`, `SECURITY_GUIDANCE_*`."

The plugin ships **no other configuration channel** — `security-guidance.md` gives only environment
variables — so this is the only way to turn one review layer off or pick the review model. A
host-run command hook inherits exactly six names; a hook that Claude's own SDK runs inside its child
inherits the whole environment. That is why the three runtimes disagree on one plugin: the same
`ENABLE_STOP_REVIEW=0` works on claude and is inert on Pi and codex. A hook's own `actionEnv` can
still override per hook, so this is about the user's ambient environment, not about all env.

Evidence: `packages/shared/src/automations/hook-command.ts:36`
`const SAFE_INHERITED_ENV_KEYS = ['HOME','PATH','SHELL','TMPDIR','TEMP','TMP']` (re-read at HEAD),
consumed at `:64-67` as the only inheritance from `process.env`; the claude arm is
`packages/shared/src/agent/claude-agent.ts` symbol `chatImpl` building the options and `packages/shared/src/agent/claude-agent.ts` symbol `ensureLiveSession` calling
`query({…})` — hooks declared in the SDK's own settings tiers run inside that child and inherit its
whole environment. (Citation corrected: the reader's line 3168 of `claude-agent.ts` was a docblock about the
loopback API-key proxy.) Triage F32.3, the env half of F32.6.

**Options.**

- **(A) Keep the six-key allowlist** — buys: the smallest possible attack surface on a shell-out we
  spawn, no list for anyone to keep correct, and `PATH` stays the only execution-relevant name;
  costs: plugin env configuration stays impossible on Pi and codex forever, and the divergence with
  claude — where it works — stays, so the security plugin is configurable on one runtime of three.
- **(B) An operator-configurable passthrough allowlist of NAMES** — buys: the same plugin
  configuration works on all three runtimes, the operator decides which names cross, and the
  divergence closes in the direction of the runtime that already has it; costs: a list somebody has
  to keep correct forever, and it becomes the ONLY containment for a hook child, since the sandbox
  route is closed by the 2026-08-12/13 standing decision.
- **(C) Inherit the whole environment on all three** — buys: exact parity with the claude arm, zero
  configuration, every plugin's documented env config works everywhere; costs: every secret in the
  user's shell reaches every hook command any plugin ships, and `PATH`/`NODE_OPTIONS`-class names
  cross with no gate — a strictly larger surface than claude's, because claude's is at least scoped
  to hooks the SDK's own settings tiers declared.

**Recommendation:** **(B)**. It is the only option that closes the difference rather than choosing a
side of it, and it matches the native-first ordering: claude's mechanism is inheritance, so the host
supplies inheritance once, bounded. Note the tension with owner sitting §1.2, whose controller
recommendation is (A)-refuse for the *settings* `env` block on the grounds that an allowlist is a
list somebody must keep correct against a threat model whose worst item is `PATH`. These are
different seams — §1.2 is a settings key applied to the AGENT process, this is ambient environment
reaching a HOOK child — but the containment argument is the same one, so answer them together, and
if §1.2 lands on (A) the consistent answer here is (A) with the divergence disclosed rather than (C).

**Parity direction:** (B) closes it uniformly; (C) closes it by levelling up to the loosest arm;
(A) leaves claude ahead and must then be DISCLOSED as a switch cost — a `SECURITY_GUIDANCE_*` value
that governs on claude and governs nothing on Pi or codex is exactly the silent divergence this fork
counts as its largest defect class.

### H#0

# Owner questions — ledger group H (Subagents, workflows, review), denominator entries H10–H52

Six questions below are new. Two more entries in this slice are already ruled and are listed under
**Already asked** — they need no question, only a pointer.

### [host] Should a session watch a merge request's CI, and may an agent act on what it sees?

Closes denominator **H20** [pi] [claude] [codex] — `absent` on all three, size L.

Native mechanism, asked: none in any runtime. Upstream drives this with the `gh` CLI from the host; our
contour is GitLab, and `dpGitlab` exists in the developer harness and in ZERO product files, so the host
would build against GitLab's API. Re-measured at HEAD, because the reader's citation did not reproduce:
`autoFix` occurs nowhere under `packages/` or `apps/` (`git grep -ain -i autofix` → 0; the tree-wide hits
are three docs files), `autoMerge\|auto-merge` → 0, and `gh pr\|gh run\|pipelineStatus\|checkRun\|ciStatus`
→ 0 over `packages` + `apps/electron/src`, against the control `gitStatus` → 43 files. Coverage map row 183
names `/autofix-pr` among *"cloud or TUI surfaces we do not ship"*; page anchor
`#monitor-pull-request-status` VERIFIED.

- **A — status and notification only** — buys: the user sees pipeline results without leaving the session, and the agent never acts on them; no new authority, no receipt mechanism owed; one poller and one notification, and the session can auto-archive when the MR merges or closes — costs: a red pipeline still needs the user to ask for a fix, so the loop upstream advertises stays open.
- **B — A plus Auto-fix that iterates on failures** — buys: the failing-pipeline loop closes without a human in it, which is the capability's actual value — costs: an agent that pushes commits in response to an external system's output, unattended; every push is a side effect no permission prompt sees, and the ledger has no receipt shape for "the agent changed the branch while you were away".
- **C — B plus Auto-merge on green** — buys: full parity with the page — costs: the agent merges. That is a product posture, not a feature; a wrong green merges a wrong change, and nothing in this fork records who decided.

Recommendation: **A**. An agent that merges is a safety posture the ledger has no receipt mechanism for, and
Auto-fix's unattended pushes want the same receipt before they are worth having.

Parity direction: **C** closes the difference with the page; **A** leaves it open and HONEST — the status bar
that exists says what it does and does not do. If A is chosen, the residue must be named in the surface, not
left silent.

### [host] Fork mode's default: match both halves of the documentation, or keep one constant and rewrite the reason?

Closes denominator **H28** [pi] [claude] [codex] — `partial` on all three, size S.

Native mechanism, asked, and it differs per runtime: Pi is ours (`NESSY_FORK_SUBAGENT`, mechanism BUILT and
defaulting OFF at `packages/shared/src/config/background-task-settings.ts:57-59`, read through
`packages/server-core/src/sessions/SessionManager.ts` symbol `forkSubagentModeEnabled`); claude-runtime takes the SDK's own default, which the page says is OFF for the
Agent SDK, so our `false` is doc-correct there; codex has `thread/fork`, which forks a THREAD, not a subagent
inheriting the parent's cache (`packages/codex-protocol/generated/ClientRequest.ts:100`). The fork agent
itself exists (`packages/shared/src/agents/definitions.ts` symbol `FORK_AGENT_NAME`, and the same file's symbol `isForkAgentName`).
The recorded reason for `?? false` has EXPIRED: the page now gives a version and a hard default
(`sub-agents.md#turn-fork-mode-on-or-off`, sentence at `sub-agents.md:1104`; its five old line anchors are
dead). No pre-existing ruling in the plan's `## Owner decisions` or in the out-of-scope register.

- **A — Pi defaults ON in interactive sessions, claude stays OFF** — buys: each runtime matches the documentation written for it; a Pi `fork` subagent inherits the conversation and the prompt cache the way the page describes, and the claude arm keeps the SDK's own documented default — costs: one more runtime difference, so it owes a `RuntimeSwitchCostRow`; and a fork inheriting the full conversation raises the per-child context cost on the default runtime.
- **B — keep one constant across all three and rewrite the justification** — buys: no switch difference at all, and the simplest thing to explain — costs: the reason on file has expired, so a fresh reason must be written and it will not be the page's; Pi users lose the prompt-cache inheritance the page treats as the interactive default.

Recommendation: **A**, with the switch-cost row written in the same commit. The documentation now states two
different defaults for two different shapes, and matching each is cheaper than defending one constant against
a page that contradicts it.

Parity direction: **A** closes the difference with the documentation while opening one at the switch — which
is exactly the case the switch report exists for. **B** keeps the runtimes uniform and all three wrong.

### [claude] Should a claude session that ships our own agent definitions still expose the SDK's built-in `general-purpose` agent?

Closes denominator **H32** [claude] — `absent`; pi and codex are `n/a` (our four built-ins are the whole set
on Pi; on codex a role is guidance and spawning is authorized independently,
`packages/shared/src/agent/runtime-agent-support.ts:52-56`). Size S.

Native mechanism, asked and found: the off-switch is the SDK's own env var, ours to set. Reproduced —
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` is in the shipped bundle (2 hits across
`node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs` and `sdk.mjs`) and scores 0 files across
`packages` + `apps`; positive control `disableAllHooks` → 2 on the same run. Today's behaviour is
DELIBERATE and written down at `packages/shared/src/agent/claude-runtime-agents.ts:885-888`, verbatim:
*"an empty record is omitted ENTIRELY rather than sent as `agents: {}`, so a session with no definitions
keeps the SDK's own built-in set (`general-purpose`, `Explore`, `Plan`, …) exactly as the runtime ships it"*.
Page `agent-sdk/subagents.md` line 172. Already triaged **TAKE** at
`docs/superpowers/specs/2026-08-28-claude-sweep-triage.md:461-471` — an engineering verdict, not an owner
ruling, which is why it is asked here.

- **A — keep it: a session with our definitions still carries the SDK's built-ins** — buys: a fallback agent always exists, and nothing changes for a session that ships no definitions of its own — costs: `general-purpose` is an unvetted agent with the full tool surface, reachable on a claude session and on no other runtime; none of our disallowed-tools, compatibility or budget checks were applied to it.
- **B — set the env var when we supply definitions, leaving only ours** — buys: the agent roster on a claude session becomes the roster the user configured, identical in kind to Pi's four; every reachable agent has passed our checks — costs: a session whose definitions are thin loses the SDK's fallbacks, and the built-ins' own capabilities (Explore/Plan) go with them unless we re-declare equivalents.

Recommendation: **B**, gated on our definitions actually being present — the condition the code already
computes at `:885-888`. Denominator H31's row supplies the same env plumbing for the Explore/Plan pair, so
the two land together.

Parity direction: **B** closes the difference — Pi and codex expose only vetted, user-visible agents, and B
makes claude match. **A** keeps claude the only runtime with an unvetted full-tool agent nobody declared.

### [host] Should the product ship a bundled workflow command out of the box?

Closes denominator **H42** [pi] [claude] [codex] — `absent` on all three, size M.

Native mechanism, asked: none on any runtime — a bundled workflow is CONTENT we would author. Pi is the only
runtime that can execute one (`packages/shared/src/workflows/workflow-keyword.ts` symbol `WORKFLOW_KEYWORD_DISPATCH_RUNTIMES`), and the
page's own example (`/deep-research`) needs WebSearch, which ledger J10 records `absent` on claude and codex.
Reproduced: `git grep -anIi 'deep.research' -- ':(glob)packages/**' ':(glob)apps/**'` → 0;
`packages/pi-agent-server/src/orchestrator/workflow-recipes.ts` is a 24-line in-memory registry whose
`registerWorkflowRecipe` (`:17`) has NO caller anywhere in the tree; positive control — the file loader does
find user and project recipes (`packages/shared/src/workflows/workflow-loader.ts` symbol `loadWorkflowRecipes`).

- **A — none: workflows stay user-authored** — buys: no token surprise from a command a user did not write, nothing to maintain against a moving page, and no capability that works on one runtime and not the others — costs: no first-run demonstration, so the workflow engine is invisible until someone reads the docs and authors a recipe.
- **B — one bundled workflow, on Pi, refused by name elsewhere** — buys: the engine demonstrates itself out of the box on the default runtime — costs: it needs WebSearch, absent on claude and codex (ledger J10), so it becomes a Pi-only capability with a named refusal on two runtimes; and a shipped recipe is content the product must keep working.

Recommendation: **A**, consistent with the owner's 2026-09-01 rulings (plan rows 25–47) against shipping
content the user did not ask for.

Parity direction: **A** is the parity-preserving answer here — B would create a new one-runtime capability.
The difference it leaves open is with the page, not between runtimes.

### [host] A budget a long task paces itself against: USD, tokens, or both?

Closes denominator **H47** [pi] [claude] [codex] — `absent` on all three, size M.

Native mechanism, asked on each runtime and the answers do not agree. claude: `Options.taskBudget` is present
in the vendored bundle (`sdk.d.ts:1717`) with ZERO production references — this arm is configuration, not
construction. codex: its own config schema carries `token_budget`, `rollout_budget`, `max_goal_token_budget`
and `unified_image_budget`, plus `ThreadGoal.tokenBudget`/`tokensUsed`/`timeUsedSeconds` and a
`budgetLimited` status (`packages/codex-protocol/generated/v2/ThreadGoal.ts:6`), and ZERO usd/dollar keys —
measured in the docblock at `packages/codex-responses-adapter/src/config-writer.ts:2466-2490`: *"THERE IS NO
USD CEILING TO WRITE HERE… Every codex budget knob is denominated in TOKENS… Closing codex's half needs a
COST SOURCE first"*. Pi: a USD per-turn cap only (`spawner.ts:346`), no token budget. The owner ruled COST
2026-08-24 (plan `:285`); the DENOMINATION is unruled, which is what this asks.

- **A — express both: keep the USD cap where a price exists, and add a token budget every runtime can honour** — buys: the capability lands on all three (codex included) because tokens are the one unit every runtime denominates in, while USD keeps working where a price is known — costs: two budgets to explain and to display, and a user can hit either one first.
- **B — token budget only, everywhere** — buys: one unit, one display, identical behaviour on all three; codex needs no cost source at all — costs: the existing USD cap and its `child-session-max-budget-usd-exhausted` spawn refusal are re-expressed or retired, and a user who thinks in money loses the ceiling they set.
- **C — leave codex uncapped and keep USD on the other two** — buys: nothing to build now — costs: a token budget the model paces itself against is exactly the capability the page describes, and it stays absent on all three; codex users get no ceiling of any kind.

Recommendation: **A**. Tokens are the only unit codex can honour, and its own goal type already carries
`tokenBudget`/`tokensUsed`, so the visible half ("see the budget being spent") is a readback rather than a
build.

Parity direction: **A** and **B** both close the runtime difference; **A** does it without retiring a control
that works today. **C** leaves the difference open on the runtime that has the native knob. Adjacent and
already asked: `…ledger-closure-owner-questions.md` §[codex] *Codex ships a USD readback of its own: wire it,
or hold the ruled explicit null?* decides whether codex has a USD subject at all — answer that one first, and
this question's A becomes cheaper or narrower depending on it.

### [host] May one request fan out into 5–30 worktree-isolated agents that each open a merge request?

Closes denominator **H51** [pi] [claude] [codex] — `absent` on all three, size L.

Native mechanism, asked: none on any runtime — upstream ships `/batch` as a bundled SKILL over subagents and
worktrees, so it is host-authorable, and we already have both ingredients: 32 files matching `worktreeLease`,
the spawner, `packages/server-core/src/pi-harness/worktree-include-plan.ts`, and an MR tool.
`git grep -a "'/batch'" -- packages apps` → 0 files. Page anchor: `agents.md` intro list. Adjacent ruling
already made: plan `:1145` sent the draft-MR half of background git to *"a separate forge/git-UI plan together
with the git panel and integrated terminal (Dev-4)"*.

- **A — MR-less batch: worktrees and branches, a human opens the merge requests** — buys: the whole parallel-execution value (5–30 isolated agents, each with its own branch) with no unattended forge writes, and it respects DR-2's routing of forge work to Dev-4 — costs: the last step is manual, so a 30-way batch ends in 30 branches somebody has to submit.
- **B — full batch with a per-MR confirmation** — buys: the page's capability end to end, with a human still in the loop once per merge request — costs: 30 confirmations is a prompt storm that trains the user to click through, which is worse than no gate; and it builds forge integration in this plan rather than in Dev-4, where it was ruled to live.
- **C — not now** — buys: nothing built, no posture taken; the ingredients keep working for hand-driven fan-outs — costs: the one capability that turns our existing worktree machinery into a product feature stays unbuilt.

Recommendation: **A**. DR-2 already routed forge work elsewhere, and A is the half that does not need it.

Parity direction: **B** closes the difference with the page. **A** closes the execution half on all three
runtimes uniformly (the fan-out is host-side) and leaves the forge half open, HONESTLY, to Dev-4.

### I#0

# Denominator group I (Isolation and worktrees) — owner questions

Four new questions, all landing on the host seam. Deduped against
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` (30 questions, headings read)
and `docs/superpowers/specs/2026-09-04-owner-sitting.md` (§1.1–§4.1, headings read): none of the four
is asked in either.

### J#0

# Owner questions — denominator group J (Tools, MCP, browser, attachments), slice 1 of 2 (J12–J56)

Seven new questions, closing eight ledger ids (J12, J14, J17, J20, J26, J30, J31, J32). One entry (J25) is already asked and is listed at the end. Checked for prior rulings against `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` (all 28 headings), `docs/superpowers/specs/2026-09-04-owner-sitting.md` (all 17 sections), the plan's `## Owner decisions` sections (lines 11–1148) and `docs/superpowers/specs/2026-08-28-out-of-scope-register.md` (O1–O28).

---

### [host] Governing the built-in browser — per-site approval and the CDP grant

**Closes ledger cells:** J12 (pi `partial`, claude `partial`, codex `absent`), J14 (pi `absent`, claude `absent`, codex `n/a`). Not on the sitting page (`browser` occurs in none of its 17 sections). Distinct from the existing question `#codex-may-a-codex-turn-drive-the-built-in-browser-and-who-pays-for-the-gate`, which decides whether codex reaches the pane at all; this one decides what governs the pane for the two runtimes that already have it.

Native mechanism, asked and answered: **none.** Anthropic's is a hosted classifier plus a device-local trust store, and the pane is our own Electron surface, so any control is host-supplied for all three. What exists today is a per-COMMAND gate — plan mode blocks state-changing browser commands and the don't-ask-again hash is keyed on the command, never on the site or the origin — plus one managed all-or-nothing kill switch. `git grep -aiE 'siteAllowlist\|domainAllowlist\|perOriginApproval'` over packages+apps → 0; `persistBrowsingSession` → 0 (`browserPane` → 50 files as the control). Full CDP is attached with no grant at all: `apps/electron/src/main/browser-cdp.ts:1-13` attaches `webContents.debugger` for a11y snapshots and element interaction with no per-origin check and no setting; `browser_use_full_cdp_access` appears only in the vendored `packages/codex-protocol/schema/config-schema.json`. Navigate entry point `packages/server-core/src/handlers/browser-pane-manager-interface.ts:226`; managed off switch `registerManagedInAppBrowserDisabledProvider` (`packages/server-core/src/bootstrap/managed-policy-resolution.ts:273-280`, P2.399) and `packages/shared/src/agent/claude-managed-settings.ts` symbol `disableInAppBrowser`. Pages: `desktop (#22)` anchors `#browse-external-sites` and `#approve-claude’s-actions-on-a-site` (the apostrophe survives the slug), `whats-new/2026-w28`, `row 18 · browser`. Codex note: P2.373 measured that codex does not act on its own `in_app_browser` flag at all, so the gate had to be ours in any case.

**Question.** What governs the agent's use of the built-in browser outside the project's own pages — and is full Chrome-DevTools access a grant of its own?

- **Nothing beyond today's managed kill switch; CDP stays implicit** — buys: no new prompts on a live feature, no trust store to build, keep, migrate or revoke, and the operator retains the one control that already works. — costs: an agent can navigate to any origin and attach an unbounded DevTools debugger to it with no record and no user decision, on the default runtime; the "which sites did it touch" question has no answer at all.
- **A host per-origin trust store: one card (Allow once / Always allow / Deny, per subdomain, revocable) gating both the first navigation to a new origin and the first full-CDP attach on that origin, plus a managed lock beside `disableInAppBrowser`** — buys: the smallest honest thing that closes the parity difference — the user is asked before the agent acts on an external site, the administrator can lock CDP off separately from the pane, and one list serves both the card and the operator allowlist the J15 row builds. — costs: a new prompt surface on a feature that today prompts per COMMAND, so existing Pi and claude users see approvals they have never seen; a trust store to persist, scope and revoke; and per-subdomain semantics to get right once, publicly.
- **Option 2 plus a host classifier band over external-origin write actions (click / type / submit) and a browsing-session persistence choice** — buys: the full documented shape, including the half that catches a page trying to drive the agent rather than the agent choosing a bad origin, and an explicit answer to whether cookies and logins survive the session. — costs: a classifier we do not have — the vendor's is hosted, so this is either a model call per write action (latency and spend on every click) or a rules list that will be wrong in both directions; plus a persistence setting whose default is itself a privacy posture.

Recommendation: **option 3 as the destination, option 2 as the thing to build first.** Option 2 is separable, needs no model, and closes the parity difference on its own; the classifier band and the persistence choice in option 3 are a clean increment on top of the same trust store rather than a rewrite. Do not ship option 3's classifier before option 2's card exists — a band with no origin record has nothing to attach a verdict to.

*Parity direction:* options 2 and 3 close the difference (Anthropic's desktop has both halves; we have neither). Option 1 leaves it permanently open and, unlike most of this group, NOT honest — no surface tells the user or the operator that browsing is ungoverned. If option 1 is chosen, the honest-surface row it then owes is `[host] name the ungoverned browser reach in the switch report and the settings copy`, size S.

---

### [claude] May a claude session reach MCP servers the app never configured?

**Closes ledger cell:** J17 (pi `n/a`, claude `absent`, codex `unknown`). Not on the sitting page. Adjacent, not the same: P6.72 ⬜ measures whether a MANAGED denial stops the spawn; this decides whether the CLI's OWN discovery runs beside the servers we hand it.

Native mechanism: **claude has the exact knob and we deliberately leave it unset.** `Options.strictMcpConfig` (page `agent-sdk/typescript` §Options, `strictMcpConfig` row). The reasoning is recorded verbatim in our own code at `packages/shared/src/agent/claude-agent.ts` (grep the quoted sentence): "`strictMcpConfig` is not set on this path, so the CLI still performs its own MCP config discovery beside the servers we hand it. Anything it connects to that way is a REAL server" — and `onElicitation` is wired at `:4906` precisely because of it. On Pi every server is a host-owned in-process proxy, so the question does not arise; the codex arm was not measured here. The existing partial ruling `docs/architecture/managed-mcp-access.md:203` records this as `inapplicable`, and **that verdict rests on a premise `packages/shared/src/agent/claude-agent.ts` contradicts.**

**Question.** Should a claude session's reachable MCP servers be exactly the set the app configured?

- **Set `strictMcpConfig: true`** — buys: the set of servers a session can reach is exactly what the app configured, which is what the managed-MCP policy already claims to guarantee; the `managed-mcp-access.md:203` `inapplicable` becomes true rather than needing a correction. — costs: a user's own `~/.claude.json` servers stop working on the claude runtime and only there, so a working setup breaks on a switch; the elicitation wiring built for CLI-discovered servers becomes dead code.
- **Leave it unset and REPORT what the CLI discovered** — buys: honesty at the seam this fork's rules prefer — the user and the operator see which servers were connected outside our configuration, and the `:203` ruling is corrected rather than left false; nothing a user has working breaks. — costs: a report is not a control; an unconfigured server still reaches the model, so a managed denial remains bypassable on claude and the guarantee stays weaker than the Pi one.
- **Leave it exactly as it is and correct `managed-mcp-access.md:203`** — buys: zero behaviour change and zero risk; the documentation stops asserting something the code contradicts. — costs: the divergence stays SILENT to everyone who does not read that architecture page, which is the defect class this whole programme exists to close.

Recommendation: **option 2** — report, and fix `:203` in the same commit. It is the only option that neither breaks a working user setup nor leaves a false guarantee standing, and it is a precondition for option 1 anyway: you cannot judge whether strict mode costs anyone anything until you can see what the CLI is connecting to.

*Parity direction:* option 1 closes the difference against Pi (where the set IS exactly what we configured); option 2 makes it HONEST without closing it; option 3 closes nothing and is included only because it is the cheapest true statement.

---

### [host] Channel opt-in: a per-session arming set, or the app-wide preference we have?

**Closes ledger cell:** J20 (pi `partial`, claude `absent`, codex `absent`). Not on the sitting page; no MCP-channel row exists among the 168 unfinished tracker rows.

Native mechanism: **neither runtime has a per-session mechanism of its own**, so this is host case (2). The host already has the shape one axis short: `ChannelPolicy.allowedSources`/`deniedSources` (`packages/shared/src/mcp/mcp-pool.ts:515-531`) plus the managed `allowedChannelServers`, and `CHANNEL_PUSH_OFF` is fail-closed (`:535`). What is missing is SESSION scope — ours is a persistent global preference (`packages/shared/src/config/storage.ts` symbol `mcpChannelPushEnabled`, default `false`, read by `getMcpChannelPushEnabled`), resolved once per session at `packages/server-core/src/sessions/SessionManager.ts` symbol `resolveChannelPolicy`. The shape difference is recorded verbatim at `docs/superpowers/specs/2026-07-31-claude-coverage-map.md:353`. Page: `channels`.

**Question.** Should opting a server into channel pushing be a per-SESSION act, as the page documents, or stay the persistent app-wide preference we built?

- **Keep the global preference** — buys: nothing to build, one place to reason about, and the fail-closed default already protects a user who never opts in. — costs: an opt-in made for one piece of work is permanent and invisible thereafter; a server that may push text into a turn keeps that right in every future session on every project.
- **A per-session arming set, seeded from the persistent preference** — buys: the page's boundary without losing the fail-closed default or the managed allowlist; several servers armed at once; the grant expires with the session, which is the property that makes third-party text injection reviewable. — costs: two scopes to explain in one settings surface, and a seeded set means the persistent preference still grants by default, so the boundary is softer than the page's.
- **Per-session only — drop the persistent preference** — buys: the documented shape exactly; no standing grant can exist. — costs: a user who wants a channel every time re-arms it every time, which is the shape people switch off entirely.

Recommendation: **option 2.** It keeps `CHANNEL_PUSH_OFF` fail-closed and the managed `allowedChannelServers` intact, adds the session boundary the page specifies, and is the only option that does not either strand a standing grant forever or tax the user on every session.

*Parity direction:* options 2 and 3 close the difference against the documented shape. Note that whichever is chosen, the ARMING is Pi-pinned today — the row `an MCP channel is armed on policy alone and only on Pi` in `rows-J-0.md` (J19 + J29) must land first, or a session-scoped grant will exist on one runtime and be silently ignored on the other two.

---

### [claude] Tool search through our own loopback adapter — leave it off, teach the adapter, or honour the choice only where it can work?

**Closes ledger cell:** J26 (pi `have`, claude `absent`, codex `absent`) — **claude arm only.** The codex arm is already before the owner at `2026-09-05-ledger-closure-owner-questions.md#codex-deferred-mcp-tool-loading-on-codex-when-the-only-live-route-is-a-hand-authored-catalogue`, whose recommendation is to decline and record the null; do not re-answer it here.

Native mechanism: **claude has the knob and we write only its OFF value.** `packages/shared/src/agent/options.ts` (`applyToolSearchOffSwitch`) is the ONLY write and it is `= 'false'`; `true`, `auto` and `auto:N` all leave `ENABLE_TOOL_SEARCH` unset, pinned by `claude-tool-search-off-switch.test.ts:102-107` (`true`/`auto`/`auto:5` → `undefined`). The reason is in the page, which for claude IS the contract — `agent-sdk/tool-search.md`, verbatim: "The SDK also disables tool search when `ANTHROPIC_BASE_URL` points to a non-first-party host, since most proxies don't forward `tool_reference` blocks. You can override that default with the `ENABLE_TOOL_SEARCH` environment variable." Our gateway loopback IS a non-first-party host. The per-runtime disposition report already exists at `packages/shared/src/agent/options.ts` symbol `describeToolSearchAcrossRuntimes`.

**Gating measurement, already a row:** P6.141 ⬜ "measure: does `ENABLE_TOOL_SEARCH=true` survive our own loopback, or only the gateway card fails it". **Answer this question after that reading, not before** — option 2's price is unknowable until it lands.

**Question.** Do we send the tool-search beta through our loopback adapter, and what happens when an operator sets `true` or `auto:N` today?

- **Leave it off — today's shape** — buys: zero risk of silent tool-definition loss, one behaviour on every non-first-party base URL, and the vendor's own default reasoning is respected. — costs: every MCP definition loads upfront on claude for gateway and BYO connections alike, so an operator with a large source set cannot reclaim that context on this runtime; and an operator's `auto:5` is silently ignored, which is a control that has stopped controlling.
- **Set `auto:N` and teach the loopback adapter `tool_reference` blocks** — buys: closes ledger J2/Claude — claude gains the deferral Pi already has, on every connection including the gateway card. — costs: the adapter must implement a beta block shape end to end; a proxy that mishandles it drops tool definitions SILENTLY, which is exactly the failure the SDK's default exists to prevent; and the beta shape can change under us with no version we control.
- **Honour the operator's choice only where the base URL IS first-party (a real Anthropic / Bedrock / Vertex BYO connection) and keep the forced OFF on the loopback** — buys: the operator's `true`/`auto:N` stops being silently ignored on the one path that can serve it, at no adapter work and no risk to the gateway card; the smallest honest thing. — costs: two behaviours by connection kind on one runtime, which must be named in the disposition report or it becomes a new silent divergence.

Recommendation: **option 3 now, option 2 only if P6.141 shows the loopback survives.** Option 3 costs a predicate and a report line and removes a dead control; option 2 is real parity but buys it with a silent-failure mode on the default connection, and its price is currently a guess.

*Parity direction:* option 2 closes the difference against Pi outright; option 3 closes it for BYO first-party connections and leaves the gateway card open but REPORTED; option 1 leaves it open and currently unreported — the report itself is P6.145 ⬜, which must land under any option.

---

### [host] Plugin-shipped message channels — allow third-party text injection into a turn?

**Closes ledger cell:** J30 (pi `absent`, claude `absent`, codex `absent`). Searched for a prior ruling: the plan has 21 `channels` hits, all substring noise; the out-of-scope register has 0. No ruling exists.

Native mechanism: **none — no runtime supplies channel plugins itself.** Our own adapter recognises the component and records a deferral rather than failing: `packages/shared/src/plugins/format-adapters/claude.ts` symbol `CLAUDE_RETAINED_SURFACE_FIELDS` carries `{ externalKind: 'channel', field: 'channels' }` (the coverage map's `:2338` citation is stale by 117 lines), and `reasonCode plugin.deferred.claude_channel` → 1 file. Nothing consumes it. Pages: `channels`, `plugins-reference` — and AGENTS.md names `channels-reference.md` among the eleven plugin-format pages, so this is a documented component type we accept and drop.

**Question.** Should a plugin be able to ship message channels — declaring `channels` bound to its own MCP server, installed and enabled per session — so third-party content can be pushed into a turn?

- **Leave it deferred, and write the deviation** — buys: no path by which installing a plugin grants anything the right to inject text mid-turn; the deferral already exists and is already recorded per plugin; nothing to build, keep or review. — costs: a documented plugin component type stays permanently unimplemented, and a plugin author who declares `channels` gets a deferral notice rather than a feature.
- **Build it host-side for all three, gated on the plugin's hook trust grant** — buys: one implementation serving every runtime (the arming row J19/J29 is a precondition either way), reusing the trust decision the user already makes for a plugin's hooks rather than inventing a second consent. — costs: a plugin's MCP server gains the ability to put text in front of the model mid-turn on the strength of a grant the user gave for something else; the blast radius of "trusted plugin" grows in a direction nobody was asked about.
- **Allow it only where mid-turn steering already exists** — buys: the capability where the runtime can actually interleave it, and nowhere else. — costs: a plugin component that works on some runtimes and not others — the silent-divergence shape, and one that a plugin author cannot see from the manifest.

Recommendation: **option 1.** The deferral is already honest, the capability's whole value is injecting third-party text into a turn, and no user has asked for it. Revisit if a first-party plugin needs it, at which point option 2 with a channel-specific grant (not the hook grant) is the shape to price.

*Parity direction:* all three runtimes are `absent`, so nothing diverges today and option 1 keeps it that way. Option 3 would CREATE a divergence to close a gap that does not exist.

---

### [claude] PowerShell as a first-class tool — enable it, refuse it, or leave it half-reachable?

**Closes ledger cell:** J31 (pi `absent`, claude `partial`, codex `absent`). Not on the sitting page. The PowerShell mentions among unfinished rows (P2.75, P6.61, P6.66) are all permission-RULE rows; none of them enables or refuses the tool.

Native mechanism: **claude has it in the shipped binary and the enabling variable already reaches the child.** Binary probe on the vendored 2.1.233 SDK: `CLAUDE_CODE_USE_POWERSHELL_TOOL` → 13, and `PowerShell` → 1 in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`; `buildClaudeSubprocessEnv` spreads `process.env` wholesale (`packages/shared/src/agent/options.ts:250`), so **an operator who exports that name today switches the tool on and we neither know nor gate it.** The permission-rule half already exists — `packages/shared/src/agent/pi-harness/claude-powershell-rule.ts`, with a `powershell` matcher case in the DSL at `permission-dsl.ts:1130` — and hooks can already request PowerShell (`packages/server-core/src/pi-harness/plugin-hook-command.ts`). The two missing halves are `defaultShell` (0 files over tracked `*.ts`/`*.tsx`, control 228) and skill-frontmatter `shell:`. Pi would need a second shell executor; codex has no PowerShell tool in `packages/codex-protocol/generated/v2/`. Page: `tools-reference`.

**Question.** This is a product question with a measured safety consequence: a `Bash`-only deny rule does not cover PowerShell, and an operator can switch the tool on by environment variable without our rule surface following. Do we enable it, refuse it, or leave it as it is?

- **Leave it as it is** — buys: nothing to build. — costs: the status quo is the worst of the three — the tool is reachable by an environment variable we forward and not covered by the deny surface we advertise, so a `Bash`-scoped denial silently does not bind. This is a control that has stopped controlling, which the standing rules treat as in scope by definition.
- **Refuse it by name: strip `CLAUDE_CODE_USE_POWERSHELL_TOOL` in `buildClaudeSubprocessEnv` and say so** — buys: closes the hole in one predicate; the deny surface's promise becomes true again; transparent, because the strip is visible in the settings copy and in the switch report. — costs: we override an operator's own environment on the runtime we vendor, and a Windows operator loses a first-class tool the binary already ships. (Precedent exists: `options.ts` already forces `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.)
- **Enable it properly: honour the variable, extend the deny surface to the `powershell` matcher, and add `defaultShell` plus skill-frontmatter `shell:`** — buys: the documented capability on the runtime that has it, with the permission floor actually covering it; the `defaultShell` half is already a buildable row (J39). — costs: a second executor inside the permission floor to keep correct forever; and Pi and codex still have no PowerShell, so enabling it CREATES a switch divergence that must then be reported.

Recommendation: **option 2 now; option 3 only if Windows is a supported deployment for this product.** The safety hole is real today and closable in one predicate; building the second executor is a real cost that should follow a decision about Windows, not precede it.

*Parity direction:* option 3 closes the difference against the documented claude surface and OPENS one against Pi and codex. Option 2 closes nothing and makes the absence uniform and honest — which, for a capability no one has asked for on two of three runtimes, is the better-shaped answer.

---

### [host] Image generation — leave codex's items rendered and unreachable, or give them an upstream?

**Closes ledger cell:** J32 (pi `absent`, claude `absent`, codex `partial`). Not on the sitting page and not in the out-of-scope register.

Native mechanism, asked per runtime: **codex has the skill and the protocol items and we already render them (P0.6)** — `packages/shared/src/agent/backend/codex/event-adapter.ts` (`isImageItem`), the same file (`imageGenerationFailureMessage`), and its warning emission, interfaces at `:110-136`. What is missing is an upstream that can serve them: the writer pins codex's `base_url` to our loopback adapter over a gateway with no image model — `packages/codex-responses-adapter/src/config-writer.ts:2900` (`base_url = http://127.0.0.1:<adapterPort>/v1`; the citation was corrected from `:799`, which is an approval-mode comment). **Claude has nothing** — four identifiers probed in the vendored `sdk.mjs` → 0 each, control `readOnlyHint` → 1. **Pi corrected `partial` → `absent`**: `rg 'imagegen\|gpt-image'` over packages/apps `.ts` → 0; the only occurrence is the vendored `packages/shared/node_modules/@earendil-works/pi-ai/dist/image-models.generated.d.ts:348`, which DECLARES `openai/gpt-image-2` but with `api: "openrouter-images"` — an upstream this product does not have, and which doubles as the positive control that the grep sees the name. Page: `78 image-generation`.

**Question.** Do we offer image generation in the chat at all — including the documented explicit `$imagegen` invocation?

- **No: leave codex's items rendered-but-unreachable and write the deviation** — buys: no new upstream, no new spend path, no new content-policy surface; the failure is already named to the user rather than silent (`imageGenerationFailureMessage` is emitted as a warning), which is the honest-divergence shape. — costs: a codex user who asks for an image gets a warning forever; the capability is `partial` on one runtime and `absent` on two, permanently.
- **Route image turns to a BYO image model** — buys: the capability for anyone who brings a key, on the connection they already configured; no gateway dependency; and it is the same BYO seam the model picker already uses. — costs: a second modality through the loopback adapter (request shape, result shape, size limits, storage of the returned bytes); a content-policy question we have never had; and it works only for BYO users, so the default gateway card still cannot do it.
- **Ask the gateway to serve an image model** — buys: the capability for every user on the default card, with one upstream and one auth path we already have. — costs: not ours to decide — it is a request to another team with an unknown answer and no date, so it cannot be planned as a lane; and it still needs option 2's adapter work once the model exists.

Recommendation: **option 1 now, option 2 later.** Record the deviation and keep the warning; revisit the BYO route if a user asks. Option 3 is worth raising as a question to the gateway team in parallel, but it cannot be this plan's answer.

*Parity direction:* option 2 closes the difference for BYO connections on codex and would extend to the other two only if their adapters gained the same modality; option 3 closes it for everyone; option 1 leaves it open and REPORTED. Note that under option 1 the claude and Pi arms owe nothing — neither runtime has an image tool to render — so the only surface owed is the deviation entry.

---

### J#1

# Owner questions — denominator group J, in-scope entries 46–48 of 48 (slice 2 of 2)

Entries in this slice: **J57**, **J58**, **J59**. All three are `BUILDABLE` in the denominator table and
survived that classification at HEAD, so **this slice raises no new owner question**. Each entry lands as a
tracker row in `rows-J-1.md` §Rows.

### K#0

# Group K — Models, effort, streaming — owner questions (slice 1 of 1)

Three of the 29 in-scope entries change a product posture and cannot be taken by a lane. None of the three
matches an existing heading in `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` or a
section of `docs/superpowers/specs/2026-09-04-owner-sitting.md` (both heading lists read in full at HEAD).

### [host] Should `ultracode` be selectable as an effort posture, or stay keyword-only?

Closes **K17**. Today `ultracode` is a host keyword only: typing the word triggers a dynamic workflow, and
nothing in the picker, no flag and no persisted key selects the posture. That the word is NOT a seventh effort
level is already a recorded decision at three sites, with a loud rejection pinned by a test — so the effort half
is closed and honest. The open half is discoverability: the page documents a settings key and a flag, and we
write neither.

- **Keyword-only opt-in (status quo)** — buys: no runaway spend, because the orchestration only starts when a user asks for it in words; the recorded max-effort decision and its loud rejection stay true; zero new surface, zero new vocabulary. — costs: the settings key and the flag the page documents stay absent; a user who never types the word never reaches the orchestration, and cannot discover that it exists.
- **A per-session Pi toggle beside the effort control, behind the workflows-off gate** — buys: the posture becomes discoverable and persists across turns; it matches the page's settings key; the existing workflows-off gate still switches the whole thing off. — costs: a standing orchestration budget the user did not price per turn — every substantive task fans out until the toggle is cleared; and a control sitting beside the effort picker will read as a seventh effort level, which is exactly the confusion the three recorded rejections exist to prevent.

Recommendation: **keyword-only**. The spend is opt-in per turn and the existing refusal is already honest.
Parity direction: the **toggle** is what closes the difference against the page (settings key + flag), at the
cost of the recorded max-effort decision and a standing budget.

Evidence: `packages/shared/src/workflows/workflow-keyword.ts:18` `WORKFLOW_TRIGGER_KEYWORD = 'ultracode'`; the
non-adoption is recorded at `packages/shared/src/automations/types.ts` (its docblock, line anchor decayed 2026-09-17) ("Nessy has no 'ultracode' effort
level"), `packages/pi-agent-server/src/orchestrator/spawner.ts:792-799`, and
`packages/shared/src/agent/thinking-levels.ts:232-234,268-276`, with `environmentThinkingOverrideRejection`
pinned by `thinking-env-tier.test.ts:96-101`; the level vocabulary is `thinking-levels.ts:34-41`
`['off','low','medium','high','xhigh','max']`. Native shape: the vendored SDK models it as
`ultracode?: boolean` (`sdk.d.ts:7206`, "xhigh effort plus standing dynamic-workflow orchestration") beside
`effortLevel?: 'low'|'medium'|'high'|'xhigh'` (`:7202`); 135 occurrences in the vendored binary; the page states
`CLAUDE_CODE_EFFORT_LEVEL` does not accept it. Pages `model-config.md#adjust-effort-level` (531), `workflows.md`.
Ledger line 1548: "the `ultracode` advertisement is closed in two of its three routes." Whether the SDK's own
`ultracode` flag is even reachable on a packaged claude session is P6.125's measurement, still open.

### [host] Ultra: should picking it change the run's SHAPE, and who decides the fan-out?

Closes **K18**. Codex's own multi-agent switch is already on — we write `[features] multi_agent = true` plus the
`[agents]` role tables — so the capability exists. What is absent is any user-facing way to say "split this
across subagents". Today the model decides alone.

- **(A) Leave it to the model** — buys: no new control, no new failure mode; the model already has the roles and the switch, and a fan-out it did not choose is usually the wrong one. — costs: a user who knows the task is parallel cannot say so; "Ultra" as a label promises a run shape the product does not deliver.
- **(B) An Ultra position that raises the subagent ceiling** — buys: one control, uniform across all three runtimes, expressible on every runtime that has a ceiling; nothing new to model. — costs: a ceiling is permission, not instruction — raising it does not make the model fan out, so the label can still under-deliver; and it collides with the unset-case ceiling divergence already queued (P6.124, and the codex-ceiling question already on the owner-questions page).
- **(C) Ultra per role** — buys: the finest control, and it maps onto codex's `[agents]` role tables directly. — costs: it exists on codex alone, so it is a new switch-visible divergence unless Pi and claude grow an equivalent; and the operator now prices three fan-outs instead of one.

Recommendation: **(A)**. Parity direction: **(B)** is the only option that closes the difference uniformly on
all three; (C) closes it best on codex and widens the gap everywhere else.

Evidence: `packages/codex-responses-adapter/src/config-writer.ts:2743-2752` — `'[features]'`,
`multi_agent = true`, with the `[agents]`-LAST placement reason in the comment above it. PARTLY RULED already:
`multi_agent` is on the owner's 2026-08-22 default-take list (plan line 22) and is written. Ledger H4/H6 cover
concurrency ceilings and budget, neither covers choosing a fan-out; K2 is the effort ENUM reaching the runtime,
and Ultra is a run SHAPE. Source page `refute_codex_3` (row 85, models).

### [codex] The service tier is a first-class codex wire field we send nowhere — user control, managed requirement, or an honest null?

Closes **K26**. `service_tier` is first-class in codex's own config and on five of its thread/turn param types,
and we send it on none of them. On claude the only spelling is Bedrock-only and unreachable here; Pi has no tier
field on any card. Searched for a RECEIVING side and found none: the Nestor gateway's catalogue carries six
fields and no tier, and our codex upstream is the loopback adapter — so today nothing downstream would honour a
tier even if we sent one. The refutation that matters: we do NOT already honour an organisation's
`requirements.toml` tier — the parser reads it and renders a warning whose own text says the requirement is not
applied.

- **(a) Send codex's `serviceTier` on `thread/start` (and per turn), claude and Pi absent** — buys: the field the runtime declares actually travels; a user or operator can pick cost-vs-latency where the wire supports it. — costs: a deliberate one-runtime capability, so it owes a switch verdict on day one; and with no receiving upstream today it may be inert in our own deployment — a control that appears to control.
- **(b) Apply the MANAGED requirement, closing B5's `'client'` field** — buys: an administrator's `requirements.toml` tier stops being a warning and becomes an effect; it closes a named enforcement hole rather than adding a user knob; it is the smaller honest thing. — costs: it binds only on codex, so the same managed file means different things on different runtimes; and it needs the model resolution moved to after the requirement is read, which is the reason the warning exists.
- **(c) Nothing, plus an honest surface** — buys: no inert control; the divergence is named where the user meets it, which is what the seam rule asks for. — costs: a declared first-class field of a runtime we ship stays permanently unused, and an administrator's tier stays a warning.

Recommendation: **(b)**. It closes a measured enforcement hole (the `'client'` cell) rather than adding a knob
with no receiver, and it is the direction the parity difference actually points. Parity direction: (b) then (a) —
(a) alone widens the switch difference without closing the managed one.

Evidence: `packages/shared/src/agent/codex-config-requirements.ts:665-666` parses `newThread.serviceTier`,
`:454` types it, `:980-990` renders it into a WARNING whose own text is "this build resolves a model for every
codex thread before the requirement is read, so the requirement is NOT applied"; the enforcement table at `:288`
marks `models` `'client'`. `serviceTier` outside `generated/`+`schema/` is three files (that parser, its test,
`__tests__/codex-fork-thread-start-params.test.ts:34`); `git grep -al service_tier -- packages apps` -> 5 files,
all generated/schema. Types `packages/codex-protocol/generated/v2/Config.ts:23`,
`ThreadStartParams.ts:12`, `TurnStartParams.ts:29-31` (re-read at HEAD: `serviceTier?: string | null`, "Override
the service tier for this turn and subsequent turns"); source `codex-rs/config/src/config_toml.rs:362` at
`rust-v0.148.0` — strong tier. Pages `amazon-bedrock.md` (`ANTHROPIC_BEDROCK_SERVICE_TIER`, Bedrock-only),
`config-sample` (row 33).

### L#0

# Denominator group L, in-scope entries 1–45 (L17–L61) — owner questions

Ten new questions plus one pointer. Each names the denominator ids it closes, its options with what they buy
and cost, a recommendation, and which option closes the runtime difference. Checked against
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` (28 headings) and
`docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 sections) — anything already asked there is a
pointer in `## Already asked`, not a restatement.

### [codex] Codex's own `[features]` table has 124 keys and we write two

Closes: **L18**. Verdicts: pi `n/a`, claude `n/a`, codex `partial`. Size M.

The mechanism is codex's own and we already open the file: `packages/codex-responses-adapter/src/config-writer.ts:2752`
writes `[features]` and exactly two keys — `multi_agent = true` (`:2753`) and `view_image = true` (`:2779`). Two more
were measured and deliberately refused with their reasons written at the site (`:2781-2812`: `tool_search`,
`codex_git_commit`), so the writer already knows how to decide. Nobody has decided for the stable user-facing ones:
hooks, apps, goals, fast mode, shell snapshot, unified exec, the remote plugin catalog. `packages/codex-protocol/schema/config-schema.json`
carries 124 keys under `properties/features` and another 124 under `definitions/ConfigProfile/properties/features`.

- **Leave the other 122 unwritten** — buys: no new posture, no maintenance surface, codex's own defaults govern.
  — costs: seven user-facing capabilities are on or off by a vendor default nobody in this fork has read, and a
  codex version bump can flip any of them silently; the fork cannot say what its own product does.
- **Write the stable user-facing subset explicitly, each with a stated reason at the site** — buys: the seven
  become ours, pinned by the config-writer test and immune to an upstream default flip; the two existing refusals
  become a pattern rather than an exception. — costs: a surface that must be re-diffed against 124 keys on every
  codex bump (P3.283 is already moving the tag), and each key needs a defended pole.
- **Write them AND expose them as settings** — buys: the user chooses per capability. — costs: seven settings rows
  with no counterpart on Pi or claude, which is a new silent divergence unless the switch report carries every one.

Recommendation: **option 2**. It matches the discipline already in the file, needs no new UI, and answers the
question the owner actually asked — what does the product do — without minting seven single-runtime settings.

Closes the difference: options 2 and 3 close it (our defaults, not the vendor's); option 1 leaves codex's behaviour
set by an unread default. Note: `features.codex_git_commit` is already tabled at sitting §1.7 / P2.11 and is
deliberately not re-asked here.

### [host] A plugin marketplace whose source is a local command

Closes: **L20**. Verdicts: pi `absent`, claude `partial`, codex `absent`. Size M.

Our resolver refuses a `command` source — four classifications, none of them a command
(`packages/shared/src/plugins/source-resolver.ts` symbol `resolvePluginInstallSource`, `:147`, `:174`, `:216`). But claude-runtime is NOT absent:
we pass `settingSources: ['user','project','local']` (`packages/shared/src/agent/claude-agent.ts` symbol `settingSources`), so the SDK's own plugin subsystem
reads the user's `extraKnownMarketplaces`, and 2.1.233 added `command` as a marketplace-entry source — a surface
our host gate cannot reach. The documented off switch `disableCommandPluginSources` is already a managed key emitted
at its restrictive pole (`claude-managed-settings.ts:434-466`, emission `:1390-1392`; 14 occurrences in the lifted
2.1.233 bundle, 0 at 2.1.223). Codex's `marketplace/add` takes `{source, refName?, sparsePaths?}` and no command kind.

- **Keep refusing `command` in our catalog and say nothing more** — buys: nothing changes. — costs: the refusal is
  true of our catalog and false of the product — a user's `command` marketplace runs inside the claude child today
  and our plugin policy never sees it. That is the fork's largest defect class exactly.
- **Refuse uniformly and close the claude leak** — buys: one honest answer on all three; the managed key that does
  it is already written and only needs to be at the restrictive pole for this source kind. — costs: removes a
  capability the binary we ship has, and the user loses a documented 2.1.233 feature with no substitute.
- **Accept `command` in our own resolver, behind an approval** — buys: parity with the page and with the vendored
  binary, on all three. — costs: we execute a user-declared command to resolve a plugin directory — the same
  execute-a-declared-command trade as the `headersHelper` question, and it needs the same approval floor.

Recommendation: **option 2 now, option 3 only together with the `headersHelper` decision**. The seam that makes
option 3 safe is one approval floor for marketplace-declared commands; taking it twice, in two shapes, is how the
floor ends up with a hole.

Closes the difference: option 3 closes it toward the page; option 2 closes it toward uniformity across the three.
Sibling already asked: `2026-09-05-ledger-closure-owner-questions.md#[host] Should a marketplace's headersHelper
command be executed to mint an archive-download credential?`

### [host] One-click plugin install from a link

Closes: **L21**. Verdicts: `absent` on all three. Size M.

Codex's is a custom URL scheme, `codex://plugins/install/<id>?marketplace=<m>`. We register exactly one scheme,
`nessy://` (`apps/electron/src/main/index.ts:194`, registered `:252`), whose policy deliberately refuses mutating
verbs from external origins — `apps/electron/src/renderer/contexts/deep-link-policy.ts:1-31`, "A link Nessy did not
produce is inert", with `EXTERNAL_BLOCKED_ACTIONS` holding seven verbs and no install verb existing to block. The
posture was reasoned in-tree and never written down as a divergence.

- **Keep the refusal and write it down** — buys: the strongest posture, unchanged; the honest surface it currently
  lacks costs one line. — costs: a marketplace page's install link does nothing in Nessy, on every runtime, and the
  user is left hand-copying an id.
- **Accept an install deep link that only PRE-FILLS the install dialog** — buys: the ergonomics without the
  mutation — the link navigates, the human presses install. — costs: a new external-origin verb in a policy whose
  whole value is that it has none; the dialog must survive a hostile `marketplace` parameter.
- **Accept it as a mutating verb for allowlisted marketplaces only** — buys: true one-click for internal
  catalogs. — costs: an external origin can install software; the allowlist becomes a security boundary.

Recommendation: **option 2**. It closes the ergonomic gap without giving an external origin a mutating verb, and it
keeps `deep-link-policy.ts`'s invariant literally true.

Closes the difference: options 2 and 3 close it toward codex's own affordance; option 1 keeps all three equal and
equally without it, which is a legitimate close by uniformity.

### [codex] A repository's checked-in `.codex/` layer, and codex's own trust model

Closes: **L22**. Verdicts: pi `unknown`, claude `unknown`, codex `absent`. Size M.

Confirmed at the STRONG tier: `codex-rs/config/src/config_toml.rs:423` `pub projects: Option<HashMap<String, ProjectConfig>>`,
`:538` `pub trust_level`, `:542-547` `is_trusted()`/`is_untrusted()`, and `:743-747` a trust decision that also seeds
`sandbox_mode` — all at `rust-v0.148.0`. We write the per-session `mkdtemp` `CODEX_HOME` whole
(`packages/shared/src/agent/codex-agent.ts` symbol `createRuntime` — `mkdtempSync` + `chmodSync(0o700)` — and `cleanupRuntimeResources` removes it at teardown) and never write a trust entry, so no
project is ever trusted and the repo's own `.codex/` layer never loads. The host already knows the answer:
`this.config.projectTrusted` is read at `:2092`, `:2129`, `:4374`. `git grep -a trust_level -- packages apps` → 2 hits,
one vendored schema and one docblock (`codex-agent.ts:1605`), never written.

- **Keep every project untrusted and say so** — buys: a checked-in `.codex/config.toml`, hooks or command rules can
  never take effect from a repository the user merely opened. — costs: codex's own project layer is dead in this
  fork, and the user is never told; a team that ships `.codex/` sees it work in codex and not in Nessy.
- **Project the host's existing `projectTrusted` onto codex's `trust_level`** — buys: native-first — codex's own
  trust gate decides, one host notion drives it, and `is_untrusted()` keeps the repo layer out for untrusted
  projects. — costs: a trusted project's checked-in `.codex/` gains real effect, including config keys we do not
  audit, and codex's own rule seeds `sandbox_mode` from that same decision.
- **Project trust but load only a named subset of the repo layer** — buys: the useful half (instructions, command
  rules) without handing a repository the sandbox and provider keys. — costs: a divergence from codex's own
  semantics that we would have to describe, and a subset list that ages against 94 top-level properties.

Recommendation: **option 2**, because `projectTrusted` already exists and already gates comparable decisions — this
is exactly the native-first ordering — with the `sandbox_mode` consequence stated at the site, and with the
credential floor unchanged (sitting §3.1 already fixes the floor's precedence over `danger-full-access`).

Closes the difference: options 2 and 3 close it; option 1 keeps codex's project layer permanently inert and needs
the honest surface instead.

### [host] Should a plugin's output style apply itself?

Closes: **L25**. Verdicts: `absent` on all three. Size S.

`output-styles.md#frontmatter` line 100 documents `force-for-plugin` and adds "If multiple enabled plugins set this,
Claude Code uses the first one loaded". The field is already PARSED and recorded as a deferral, so only the honouring
is missing: `packages/shared/src/plugins/format-adapters/claude.ts:995-1001` pushes an `output-style-force` deferral
with reasonCode `plugin.deferred.claude_output_style_force_for_plugin`; `packages/shared/src/capabilities/resolver.ts` symbol `RuntimeOutputStyleDefinition`
states "nothing here applies a style on its own"; `runtime-output-styles.ts:12` repeats it.

- **Keep the deferral, permanently, and surface it** — buys: no plugin can change how the assistant speaks without
  the user selecting it; the same unattended-default refusal the fork already applies to a plugin's `agent` key. —
  costs: a documented field stays inert on all three runtimes and the plugin author's intent is silently dropped.
- **Honour it, with the page's first-loaded tie-break** — buys: documented behaviour, identical on all three because
  the host owns prompt composition. — costs: enabling a plugin changes the assistant's voice with no user action,
  and the tie-break is order-dependent — the exact "unattended default" shape the fork refuses elsewhere.
- **Honour it as a PROPOSAL** — the plugin's style is offered and applied on one confirmation — buys: the author's
  intent reaches the user; nothing changes unattended. — costs: a third state in the output-style model, and a
  prompt at plugin-enable time.

Recommendation: **option 1**, kept consistent with the `agent`-key refusal (see the next question) and made visible;
if the owner wants the capability, **option 3** is the version that does not smuggle a default.

Closes the difference: all three options close it — the cells are equal today; the question is which pole.

### [host] Should a plugin ship default settings, including the `agent` key?

Closes: **L26**. Verdicts: `absent` on all three. Size M.

The value is parsed, checked against the plugin's own agents, recorded as `deferred: settings-agent` and refused with
a warning: `packages/shared/src/plugins/format-adapters/claude.ts:2581-2626`, whose refusal text is
"a plugin silently replacing the main thread's system prompt, tool restrictions and model is the same unattended-default
move this fork already refuses for output styles". Claude could carry it through `buildClaudeRuntimeAgentOptions`, so
the refusal is a posture, not a missing seam. Prior record: f053 specs Step 1 (landed) and Step 2, which stops at
"only if the owner approves honouring `agent` at all".

- **Keep refusing the `agent` key; honour the rest of a plugin's default settings** — buys: a plugin can ship
  sensible defaults without being able to replace the main thread. — costs: the split needs a defended key list, and
  a plugin author reading the page sees a documented key refused.
- **Refuse the whole `settings` block** — buys: one rule, no list to maintain, no plugin-supplied default anywhere. —
  costs: the most useful half goes with the dangerous half.
- **Honour `agent` too, on first enable, behind an explicit confirmation naming what changes** — buys: full
  documented behaviour. — costs: a confirmation the user will click through, after which a plugin owns the system
  prompt, the tool restrictions and the model.

Recommendation: **option 1**. It preserves the refusal the code already argues for, and the same reasoning should
settle `force-for-plugin` above — one posture, stated once, for both unattended-default fields.

Closes the difference: all three close it; the cells are equal today.

### [host] Replacing or appending the model's base system prompt

Closes: **L30**. Verdicts: `absent` on all three. Size M.

Claude has TWO native forms — `Options.systemPrompt` as `{type:'preset',preset,append}` (`sdk.d.ts:2048`) and
`SDKControlInitializeRequest.appendSystemPrompt` (`sdk.d.ts:3664`) — and we set only the preset form with our own
append (`packages/shared/src/agent/claude-agent.ts` symbol `buildClaudeTurnShapeOptions`); `appendSystemPrompt\|append_system_prompt\|systemPromptFile` → 0 files across
`packages/shared/src`, `packages/server-core/src`, `apps/cli/src`, `apps/electron/src` (positive control `systemPrompt`
→ 8 hits in `claude-agent.ts` alone). Pi's `PromptBuilder` is ours. Codex has `model_instructions_file` as a top-level
key and as a `ConfigProfile` field (`codex-rs/config/src/config_toml.rs:239` @ `rust-v0.148.0`), written in 0 places
outside the vendored schema — and our guidance already reaches codex additively through `developerInstructions`
(`codex-agent.ts:3169`, `:4643`, `:4670`). So the missing thing is the REPLACING form, not a missing channel.

- **Offer neither** — buys: our prompt composition stays the only one; codex's 20,751-char base prompt is never at
  risk (the trap P3.35 recorded and P6.173 is repairing). — costs: a documented per-invocation capability is absent
  on all three, and an operator with a house prompt has no route.
- **Offer APPEND only, on all three** — buys: a user/operator addition on top of the vendor prompt, deliverable
  natively on claude (`appendSystemPrompt`), on Pi through `PromptBuilder`, and on codex through the
  `developerInstructions` channel already live — three native mechanisms, no replacement anywhere. — costs: the
  append text lands in a different slot on each runtime, so its precedence differs at a switch and the switch report
  owes a row.
- **Offer append AND replace, replace refused on codex by name** — buys: full parity with `cli-reference` on the two
  runtimes whose prompt we compose. — costs: a replace silently deletes the safety and engineering sections
  (P6.171's floor) unless the floor is re-added after replacement; and the codex refusal is a permanent asymmetry.

Recommendation: **option 2**. Every runtime already has a native additive channel — this is native-first with no new
host machinery — and replacement is the form that both deletes codex's base prompt and can strip the safety floor.

Closes the difference: option 2 closes it additively on all three; option 3 closes it further on two and widens the
codex asymmetry. SEQUENCE after P6.171 (the safety floor's single producer), whose outcome decides whether a replace
could ever be safe.

### [host] Relative paths in `additionalDirectories`

Closes: **L40**. Verdicts: `absent` on all three. Size S.

Ours is the single reader for all three (`getConfiguredAdditionalDirectories`), and the refusal is deliberate and
reasoned: `packages/shared/src/agent/additional-directories.ts:45-47` pushes
`additionalDirectories: ignoring relative entry "…" — use an absolute path.` and `continue`s, with the reason in the
function header at `:32-36` — "there is no unambiguous cwd at gate time, so resolving one would make the granted root
depend on where the app was launched from". Diagnostics go to `log.warn` only (`:92-94`). The page documents
`"../shared"`, `"../web"` (`large-codebases.md:282`). This is a posture question, not a defect — and it is DISTINCT
from sitting §1.4, which is the Pi arm and the memory opt-in, not path shape.

- **Keep refusing relative entries, and raise the diagnostic out of `log.warn`** — buys: a granted filesystem root
  can never depend on the launch directory; the user finally sees the refusal. — costs: a documented path shape does
  not work; a user copying the page's own example gets silence today and a warning after.
- **Resolve relative entries against the SESSION's working directory** — buys: the page's shape works, on all three,
  from one reader. — costs: the exact hazard the header names — the same settings file grants different roots
  depending on where the session started, and a permission grant is the worst place for that.
- **Resolve them against the settings FILE's own directory** — buys: the page's shape works and the resolution is
  unambiguous and stable — a project `.claude/settings.json` saying `"../shared"` always means the sibling of the
  project. — costs: it is not what the page means by "where the session started", so we would be documenting a
  deliberate difference.

Recommendation: **option 3**, with the difference written down. It gives the user the documented shape while removing
the launch-directory dependence the header refuses — the header's objection is to option 2 specifically, not to
relative paths as such.

Closes the difference: options 2 and 3 close it toward the page; option 1 closes it by uniform, visible refusal.

### [host] Background distillation of finished chats into durable memories

Closes: **L49**. Verdicts: pi `partial`, claude `unknown`, codex `absent`. Size L.

Codex HAS the whole subsystem: `codex-rs/config/src/types.rs:288-319` `MemoriesToml` (exactly 12 fields at
`rust-v0.148.0` — `generate_memories`, `use_memories`, `disable_on_external_context`,
`min_rate_limit_remaining_percent`, `extract_model`, `consolidation_model`, `max_rollout_age_days`,
`min_rollout_idle_hours`, …), `config_toml.rs:441` `pub memories: Option<MemoriesToml>`. It is unreachable for a HOST
reason: `~/.codex/memories/` sits inside the ephemeral per-session `CODEX_HOME` we create and delete. Ours is
model-invoked only — `packages/session-tools-core/src/handlers/remember.ts:26-29`, the `nessy:auto:` marker is
appended by the tool, so nothing distils a chat on its own. We write two `[features]` keys and neither memories key.

- **Stay model-invoked on all three** — buys: nothing is written to durable memory that the model did not decide to
  write in the open; no background model calls, no background spend. — costs: a documented capability absent
  everywhere, and codex's own subsystem stays dead inside an ephemeral home.
- **Adopt codex's subsystem on codex, and leave Pi/claude model-invoked** — buys: native-first, no host build. —
  costs: a switch changes whether finished chats become memories at all, plus a second extraction model the user
  never chose — a new silent divergence unless the switch report and a setting carry it; and it needs a durable
  `CODEX_HOME` for `memories/`, which is a real change to the ephemeral-home decision.
- **Build one host distiller for all three, and switch codex's own OFF** — buys: one behaviour, one model choice, one
  spend, uniform at a switch; codex's `generate_memories = false` is the documented off switch and P6.166 is already
  writing that block. — costs: a host background model call per finished chat, its cost and its failure modes, and a
  quality bar we own.

Recommendation: **option 3**, sequenced after P6.166 (which already opens codex's `[memories]` block and is the
switch-verdict half). Option 2 is native-first in form but manufactures exactly the divergence the native-first rule
exists to prevent.

Closes the difference: option 3 closes it uniformly; option 2 closes the codex cell and widens the switch cost;
option 1 closes it by equal absence and owes the disclosure.

### [codex] Codex's bundled skill tree, which the host's off switch cannot reach

Closes: **L56**. Verdicts: pi `n/a`, claude `n/a`, codex `absent`. Size S.

A cold managed `CODEX_HOME` comes back holding codex's re-extracted bundled `skills/` tree — 87 entries, measured on
the shipped `darwin-arm64` build (`codex-agent.ts:896`, 2026-09-03, two differing `installation_id`s as the positive
control) — and our developer instructions are placed ahead of codex's own `<skills_instructions>` (`:1177-1179`). The
host's switch exists with no codex projection: `packages/shared/src/config/bundled-skills-settings.ts`
(`disableBundledSkills` / `NESSY_DISABLE_BUNDLED_SKILLS`). Codex's own keys are in the vendored release schema
(`SkillsConfig`): `include_instructions`, `bundled.enabled` (`BundledSkillsConfig`), and `[[skills.config]]`
`path`/`name` + `enabled`. `bundled.enabled = false` is the exact analogue of our switch; none is written
(`git grep` for `[skills]`, `include_instructions`, `[[skills.config]]` outside `schema/`/`generated/` → 0 emit sites).

- **Project the host switch onto `bundled.enabled`** — buys: `disableBundledSkills` finally means the same thing on
  all three runtimes; native-first, one key, no host machinery. — costs: codex's own useful bundled skills go with it
  — including `$skill-installer`, which is the only skill-by-name installer in the product (L62) — so a user turning
  off OUR bundled skills silently loses codex's too.
- **Leave codex's tree on, and say so** — buys: codex keeps its own capabilities; one honest line at the switch. —
  costs: a documented off switch is half-true, which is the fork's largest defect class; the model sees 87 skills the
  host neither lists nor gates.
- **Project the switch AND surface codex's tree in the host skill list** — buys: one switch, one list, per-skill
  control through `[[skills.config]]`. — costs: 87 entries enter a host surface built for our own, and the list must
  survive a codex bump re-extracting a different tree.

Recommendation: **option 1** as the immediate honest move, with **option 3** as the finished shape once
`skills/list` is wired (the row composed for L60). Option 2 leaves a control that does not control.

Closes the difference: options 1 and 3 close it; option 2 closes it only in the honest-surface sense.

### L#1

# Owner questions — denominator sweep, ledger group L, entries 46–90 (L62–L106)

Four of the 45 entries in this slice are OWNER. None is already asked on `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` or on the sitting page; the near-misses are listed under "Already asked" at the end.

### [host] Should `openai/skills`, the vendor's own catalog of reusable skills, be known to the product?

Closes: denominator **L63** (Pi `absent`, Claude `absent`, Codex `absent`). Nothing runtime-specific is missing — our own skills installer already accepts a git source; the catalog is simply not known to the product. Evidence: `openai/skills` = exactly 3 tracked files, all documentation or a type comment (`2026-08-22-codex-coverage-map.md`, `2026-08-29-codex-blocked-column-triage.md`, `packages/shared/src/skills/types.ts`), 0 production readers; control on the same corpus, `github.com/openai/plugins` = 21 files.

- **Ship it as a built-in catalog entry, default on** — buys: a named, curated skill installable in one act on all three runtimes through the git source we already accept, closing the gap uniformly; costs: a second default-on remote catalog whose contents we do not review, and an OpenAI-hosted supply-chain surface beside the plugin marketplaces in an internal fork.
- **Ship it as a built-in entry that is present but disabled, one click to enable** — buys: discoverability with an explicit user act, and the reserved-name protections (L14) still apply; costs: a first run still shows nothing, and "present but off" is a state the marketplace UI does not have today.
- **Decline, and keep only the generic git source** — buys: no new default trust and no new review burden; costs: the catalog stays invisible, every user hand-types a URL, and the capability stays `absent` on all three.

Recommendation: **B**. Parity direction: **A** is the option that closes the difference outright — one host entry, identical on Pi, claude and codex.

### [host] Is plugin INSTALL scope a user choice, or does one store plus enablement scope stand in for it?

Closes: denominator **L79** (`partial` on all three), and it fixes the scope SET that denominator **L78**'s row implements. What exists is ENABLEMENT scope (global / workspace / project) plus a project file, not INSTALL scope; the RPC install handler takes no scope at all. Evidence: `grep -an scope packages/server-core/src/handlers/rpc/plugins.ts` → 0 hits at HEAD; enablement scopes at i18n `en.json:1292-1296`; `packages/shared/src/plugins/project-config.ts:14-20` (a project file "can never grant trust, credentials, provider auth, environment, filesystem roots or shell commands"); `packages/shared/src/plugins/types.ts:4` — the three-member enum is the whole space; `discover-plugins.md` lines 296-298.

- **Offer the choice at install time — for me / for this repository / for me in this repository only** — buys: the page's four-scope model, a home for L78's gitignored scope, and one host answer serving all three runtimes; costs: a decision at every install, and a store migration, because installs today carry no scope at all.
- **Keep one install store and extend only enablement scope** — buys: no migration and no new UI; costs: a plugin wanted for one repository is still fetched and stored machine-wide, and the documented `local` scope stays absent on all three.
- **Add the scope in the CLI only, defaulting to user scope in the app** — buys: provisioning and scripting get it with the CLI verbs L86/L87 build anyway; costs: two mental models for the same store, and the desktop user never sees the choice.

Recommendation: **A**. Parity direction: **A** — the store is host-owned and provider-blind, so one build moves all three columns at once.

### [host] Should the official Anthropic marketplace be delivered by default?

Closes: denominator **L90** (Pi `absent`, Claude `absent`, Codex `absent`). Not a build: the host already has the delivery mechanism, and the vendored runtime's own auto-registration acts on ITS `known_marketplaces.json`, not ours. Evidence: `packages/shared/src/marketplace/registry-source.ts` symbol `ensureDeliveredMarketplaces` ("Idempotent, and safe to call on any read path"), called from `list()` at `:1573`; built-in registry i18n `en.json:1257` "Skills Market"; plan row P2.12 (`80d53ff28`+`cb70c7f1b`) — "the live install works end-to-end on HEAD: 7/7 agents, 1/1 skill, 1/1 hook — and 0/1 workflows"; `plugins/install.md#install-a-plugin (was line 29 of the retired discover-plugins page)`. Related but distinct: the auto-install OPT-OUT for the runtime's own copy is denominator L19 (a BUILDABLE S row, not this question).

- **Deliver it as a built-in entry, default on** — buys: the documented default behaviour, plugins available with nothing added by hand, identical on all three runtimes; costs: a default-on connection to a vendor-hosted catalog from a T-Bank-internal fork, and the L14 reserved-name protections become load-bearing.
- **Deliver it present but disabled, one click to enable** — buys: presence and discoverability without a default outbound trust; costs: the first run still shows an empty browse list, and the documented behaviour is still not what ships.
- **Decline: keep only the built-in "Skills Market" registry** — buys: no vendor catalog in an internal product, and one curated source; costs: a user following the vendor's own documentation finds nothing, on every runtime.

Recommendation: **B**. Parity direction: **A** closes the difference against the page; B closes it against the *user's* complaint at the cost of one click.

### [host] Should plugin suggestions read the session's own history — commands run, hosts fetched, files read?

Closes: denominator **L93** (Pi `absent`, Claude `absent`, Codex `absent`), and it decides what denominator **L92**'s suggestion surfaces are allowed to say. Asked and answered in-tree already, on scope grounds: four of five signals need per-session history this fork records on no runtime, so implementing them would be four matchers that can never fire; the record is parsed tolerantly instead. Evidence: `packages/shared/src/marketplace/relevance.ts:20-28` (the scope decision, "four matchers that can never fire"), `:36-45` `PluginMarketplaceRelevanceV1.signals` typed with `cwd` only, `:44` `export type PluginRelevanceSignalKind = 'cwd'`; `plugins/org.md#recommend-plugins (was line 79 of the retired plugin-relevance page)`.

- **Record the four missing signals in a per-session relevance log** — buys: the page's whole matcher set fires, suggestions become worth showing, and one host record serves all three runtimes; costs: a new per-session behavioural record of commands, hostnames and file reads — a privacy and retention posture this fork has never taken — plus multi-lane storage and expiry work.
- **Add only the manifest-dependency signal, which needs no history** — buys: a second live matcher read from a file the host already opens, with no behavioural recording at all; costs: three of five signals stay dead and the suggestion stays weak.
- **Keep `cwd` only, and state the narrowing where the suggestion appears** — buys: nothing new to build; costs: the capability stays `absent` on all three and the page's own Note is half-honoured.

Recommendation: **B**. Parity direction: **A** — it is the only option that closes the capability, and it closes it host-side for all three at once.

### L#2

# Owner questions — denominator group L, slice 3 of 3 (entries L107–L133)

Checked against the existing headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md`
and `docs/superpowers/specs/2026-09-04-owner-sitting.md` before writing; none of the four below is already asked.

### [host] Should Nessy accept Claude Code's own settings vocabulary for the interactive-mode keys?

Closes: L126 (`spellcheck`, `emojiCompletionEnabled`, `keybindingFlavor`, `promptSuggestionEnabled`,
`vimInsertModeRemaps`, `autoContinueAtUsageLimit`; `partial` on Pi, Claude and Codex, because a user's pasted
`~/.claude/settings.json` is read for some families and these keys land in none of them).

- **Accept all six as compat aliases** — buys: a user who pastes their Claude Code settings file gets what they
  wrote, on all three runtimes, and the alias mechanism is chosen rather than invented — the tree already does this
  for another name pair (`NESSY_SAFE_MODE` / `CLAUDE_CODE_SAFE_MODE`, `shared/src/config/safe-mode.ts:63,:66`) —
  costs: two of the six have no host behaviour at all (`keybindingFlavor`, `vimInsertModeRemaps`), so accepting
  the NAME without the behaviour manufactures exactly the silent divergence this fork keeps closing.
- **Accept only the names we already implement, and diagnose the rest** — buys: `spellcheck` maps straight onto
  the built spell-check surface (`apps/electron/src/renderer/pages/settings/InputSettingsPage.tsx` symbol `handleSpellCheckChange`, `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` symbol `loadInputSettings`), so every
  accepted name does something, and each unaccepted one produces one honest line naming Nessy's own spelling or
  saying there is no equivalent — costs: five of the six still do not take effect; the user rewrites their file.
- **Accept none, and say so once** — buys: the cheapest possible change, one diagnostic at settings-load time,
  uniform on all three — costs: parity direction unmoved; the paste-your-file story stays broken.

Recommendation: option 2. It is transparent (every key either works or is named), simple (no new behaviour), and
it leaves option 1 reachable later. Option 1 is the one that closes the difference, and it should be taken only
once `keybindingFlavor` and `vimInsertModeRemaps` actually have host implementations to alias onto.

### [host] Does importing a setup include the conversation history and the project memories?

Closes: L131 (`absent` on Pi, Claude and Codex; `claude-setup-import.ts:61` lists exactly five kinds, none of them
a chat or a memory). Codex's own `/import` is documented as unavailable "while connected to a local app-server
daemon", which is our topology — a page-only reading, so WEAK tier: intent, not measured behaviour.

- **Setup only, as today** — buys: the importer stays a bounded five-kind converter with a dry run and no store
  migration; nothing new can leak — costs: a switching user loses 30 days of context and their project memories,
  which is the part they actually notice on the first turn after switching.
- **Import memories, not chats** — buys: project memories are files our instruction readers already understand,
  so the write is the `cpSync` shape the skill kind already uses; the steering the model receives survives the
  switch, which is the half that changes what the model is told — costs: memory files can carry material the user
  did not mean to move into a new workspace, so the dry run needs a per-file preview, not just a badge.
- **Import both, with chats read-only** — buys: full continuity, the strongest switching story — costs: a chat
  store schema we do not own on any of the three runtimes and no native route to copy one (codex's own `/import`
  is unavailable on our topology); L-sized, and the evidence for the codex arm would stay weak.

Recommendation: option 2. It closes the arm that changes what the model is told, with a mechanism we already have
and can measure, and it leaves the store migration honestly unowned instead of half-built.

### [host] Is the importer a one-shot converter, or a standing link to the other agent?

Closes: L132 (`absent` on all three; reproduced search — `claudeImport\|importAgentSetup` over packages and apps
hits only the two import components, the onboarding playground entry and two locale files, so the one-shot
converter is the only importer that exists).

- **One-shot, as today** — buys: no watcher, no re-run record, no drift semantics; the dry run is the whole
  contract and the failure modes are bounded — costs: a user who keeps using Claude Code watches the two setups
  diverge with nothing saying so, and an imported plugin or connection that still needs authorisation is never
  surfaced anywhere.
- **One-shot plus a re-run that diffs** — buys: the compute phase already produces a plan with create/merge/
  conflict badges, so re-running it against the current `~/.claude` is nearly free and answers "what changed since
  I imported" without any watcher — costs: a conflict policy becomes a product decision (whose edit wins when both
  sides changed), and the needs-authorisation card is still separate work.
- **A standing sync, with the authorisation card** — buys: the whole promise, including the card for an imported
  plugin or connection that still needs auth — costs: a watcher over a directory we do not own, a re-entrant apply
  path, and a new failure mode in which a change made in Claude Code silently changes Nessy's behaviour.

Recommendation: option 2, plus the authorisation card built as its own surface rather than as a consequence of
syncing. Option 3 makes an external directory a live input to our permission posture, which is the direction this
fork has spent the plan closing.

### [host] Which agents may Nessy import from, beyond Claude Code?

Closes: L133 (`absent` on all three). A deferral already stands and this question is whether it still should:
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` §"Recorded deviations (harvested by P5.3)" — "Dev-13 Import sources beyond Claude Code
(Cursor, Cowork): later" — and `claude-setup-import.ts:34` "Cursor is deferred (Dev-13) and is not read here".
What has changed since Dev-13 is that a complete importer now exists for one source: scan → dry-run plan →
per-change create/merge/conflict badge → apply, mounted in Settings, onboarding and the playground.

- **Keep Dev-13's deferral** — buys: nothing new to maintain, and the importer's evidence stays strong because it
  reads one format we understand — costs: the one other agent our own product ships a runtime for, codex, cannot
  have its setup imported at all, so a codex user starting in Nessy imports nothing.
- **Add `~/.codex` only** — buys: our own adapters already read every target component type
  (`packages/shared/src/plugins/format-adapters/claude.ts`, `packages/shared/src/capabilities/native-sources.ts`),
  so only a `~/.codex` reader is missing, and codex is the one foreign format we can verify against open source
  and a shipped binary rather than a page — costs: one more reader to keep against `rust-v0.148.0`, whose upstream
  is already four minors ahead (P3.283).
- **Add codex, Cursor and Gemini CLI** — buys: the widest switching story, and the importer's UI is already built
  for it — costs: three foreign formats we do not drive; two of them could only ever be evidenced from pages, the
  weak tier, so their cells would be hypotheses rather than measurements.

Recommendation: option 2. Codex is the source we build from source and can measure; Cursor and Gemini stay on
Dev-13's deferral with the reason restated at the call site so the next reader does not re-open it blind.

### M#0

# Owner questions — ledger group M (Observability and diagnostics), entries M4–M41

Five new questions. Each names the ledger ids it closes, the options, a recommendation, and which option
closes the difference between runtimes. Checked against the headings of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and
`docs/superpowers/specs/2026-09-04-owner-sitting.md` — none of the five is asked there.

### [host] Should an operator be able to supply the model price table this app costs sessions against?

*Closes ledger cell **M9** (pi `absent`, claude `absent`, codex `absent`). Unblocks the "managed" value of
**M10**'s price-basis label, which is otherwise buildable as list/unknown only.*

**ANSWERED AND DELIVERED — this heading is kept for the record, not as an open question (re-verified
2026-09-11).** The owner took **A** as decision D11 on 2026-09-05 and P6.537 (`c40a8f736`) built it
host-side for all three runtimes:
`packages/shared/src/config/managed-model-prices.ts` symbol `priceUsageWithManagedTable` is reached from
`packages/shared/src/agent/base-agent.ts` symbol `managedBudgetPriceUsd`, which every runtime inherits. The ledger cell reads pi `covered`, claude
`partial`, codex `covered` since then. What survives as open is one NARROWER trade, and the
re-measurement below is what opened it: whether to emit `modelPricing` to the claude child so its own
cost figures agree with the host's, at the price of an env flag that also strips an administrator's
model pins. The options as written are the record of how A was chosen.

`modelPricing` is documented on `settings-reference.md#modelpricing` and is **absent from the vendored bundle**
(`grep -aoF modelPricing sdk.mjs` → 0 at 0.3.233, controls `Cookie` → 5, `git-subdir` → 4), so the bundle lags
the contract and claude cannot be configured into it either. **That bundle reading is dated 2026-09-05 and the
SDK lift to `0.3.247` refuted it — re-measured 2026-09-11: `modelPricing` scores 10 in `sdk.mjs`, 2 in
`sdk.d.ts` and 28 in the native binary, counted with `grep -aoF` against negative control
`nessyNotARealSdkKey` → 0 on each artefact.** The bundle no longer lags, so the question stops being *can
claude be configured into it* and becomes *should we set it*. Neither option's text below changes; what
changes is that **A** now rests on a measured native mechanism on one runtime rather than on a documented
absence — and that mechanism is an ENV GATE, not a plain setting: the managed-settings policy context
reads `modelPricing` whole only when `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set, and that same flag
strips `model`, `fallbackModel`, `modelPicker` and `modelOverrides` from the ADMIN tiers and filters their
`env` block. So A is cheaper to reach than it was and carries a cost it did not have. Pi and codex have no price table of any kind;
codex reports tokens and never USD. The consequence is written in our own source: the vendored path's value
"is 0 on every result … `sessionCostUsd` never moves"
(`packages/shared/src/agent/backend/claude/event-adapter.ts` symbol `ClaudeEventAdapter`), and the sole repo occurrence of the
key is a comment at `packages/shared/src/config/managed-env.ts` symbol `NO_WITHHELD`. A gateway or BYO model the bundled table
cannot price therefore costs nothing, and any USD budget cap over it is inert.

- **A — a host-side managed price table read by all three runtimes** — buys: cost estimates and USD budget caps
  become real for gateway and BYO models on every runtime, one implementation, and the M10 label gains its
  "managed" value so an operator can see which table priced a request — costs: upkeep of a price list the
  operator must maintain, and a wrong entry silently produces a confidently wrong cost figure and a cap that
  fires at the wrong moment.
- **B — keep "Not reported" and cap in tokens** — buys: nothing is ever invented; the honesty surface we already
  ship (`usage.costUnavailable`, `usage.costPartial`) stays the whole answer, and token budgets are exact —
  costs: no USD ceiling can bite on a gateway model on any runtime, and the documented `modelPricing` clause
  stays unmet on the runtime whose documentation is our contract.

Recommendation: **A**, with the table operator-supplied and never bundled, and every priced figure carrying
M10's basis label so a managed price is visibly a managed price.
Parity direction: **A** closes the difference — it is the only option under which all three runtimes can price
the same session identically. **B** leaves all three equally unable, which is uniform but leaves the cap inert.

### [host] Should the configuration checkup be allowed to change anything after you confirm, or stay a report?

*Closes ledger cell **M14** (pi `absent`, claude `absent`, codex `absent`). The read-only half is delivered
(M15, `e40c1dedd`) and its desktop reach is already tracked by P6.168.*

`debug-your-config.md` draws a line our CLI quotes back at itself: `apps/cli/src/doctor.ts:20-23` states the
CLI form "never repairs anything, which is the difference `debug-your-config.md:44` draws", and `:2`/`:70`
record it as "the read-only configuration checkup", "read-only and session-free". The fixing half was
recorded as a deliberate non-implementation:
`docs/superpowers/plans/2026-07-29-doctor-surface.md:216-218` ("the fixing half is a different product from a
read-only report") and `:260-271` (Deviation 1, `documented, not implemented`, "Cost: 1 small slice"). No
runtime supplies the fixing half either: claude's own `/doctor` is inside the closed binary and unreachable
through the SDK query surface, codex has no config command at `rust-v0.148.0`, and `/checkup` has no parser
row (`packages/shared/src/slash-commands/help.ts` symbol `HELP_COMMAND_LABEL`, 21 entries, no `doctor`/`config`/`debug`).

- **A — stay read-only, and say so in the CLI help and the in-app view** — buys: zero new mutation surface, the
  existing invariant and its tests hold, and one sentence closes the expectation gap — costs: the page's
  propose-and-apply clause stays unmet, and every finding the checkup makes still has to be fixed by hand.
- **B — propose and apply after explicit confirmation, scoped to the two safe finding classes** (a derivable
  `CLAUDE.md` trim and a slow-hook fix) — buys: the documented behaviour on the two findings where the fix is
  mechanical and reversible, one host implementation serving all three runtimes — costs: the checkup becomes a
  thing that edits the user's files; every apply needs a diff preview, an undo and its own tests, and the
  blast radius of a wrong trim is the model's instructions.
- **C — B, plus removing unused skills, MCP servers and plugins** — buys: the page's clause in full — costs: the
  destructive half, where "unused" is a heuristic over surfaces the user may have installed for next week.

Recommendation: **B**, exactly as the sweep sized it — derivable-`CLAUDE.md` and slow-hook findings only, each
behind a diff preview and a confirmation, with removal left out until asked for by name.
Parity direction: all three options are uniform across runtimes (the checkup is host-side), so this is a
product-posture question and not a parity one; **B** closes the difference against the documented product.

### [host] May host telemetry name a person and a session?

*Closes ledger cell **M33** (pi `absent`, claude `absent`, codex `partial`). Also gates the correlation-id
rider on **M31**.*

Both runtime children implement the page's standard-attribute table — binary probe
`OTEL_METRICS_INCLUDE_SESSION_ID` → 6, control 0; for codex the vendor's `[otel]` block carries the switch and
we pin it off. On all three the mechanism EXISTS and this fork withholds it, deliberately and in writing:
`packages/shared/src/telemetry/usage-metrics.ts:31-52` — "This fork exports NEITHER, nor any other row of that
table … no per-user or per-session identifier leaves the operator's machine … This fork implements none of
those flags" — and the Pi event stream carries only HMAC-SHA256 digests under a locally generated salt
(`packages/server-core/src/pi-harness/otlp-telemetry.ts:29-38`, `:205-212`). Not ruled in the plan's owner
sections nor in the out-of-scope register.

- **A — counts only; keep the current deviation and document it as the product's position** — buys: nothing
  personal ever leaves the machine, the existing HMAC design stays coherent, and no new consent surface is
  needed — costs: an operator cannot build the per-user audit trail the page describes, so tool calls and MCP
  activity stay unattributable; the deviation stays permanent on all three runtimes.
- **B — identity behind the documented toggles, default off** — buys: `enduser.id`/`session.id` and the rest
  arrive only where an administrator turned them on, using the vendors' own switch names on claude and codex
  and one host implementation for Pi; parity with both runtime children — costs: a real per-user identifier
  can leave the machine once enabled, so the toggle needs a visible statement to the user whose session it
  names, and the Pi HMAC scheme gains a second, non-anonymous mode.
- **C — full parity including content** — buys: everything the page offers — costs: this is the M34 question
  below, and answering it here would decide it silently.

Recommendation: **B** — and it is already the recorded recommendation:
`docs/superpowers/plans/2026-07-29-observability-and-cost.md:183` says "the toggles, not a default", `:185` for
the five `OTEL_LOG_*` channels. Add M31's per-turn OPAQUE id under either A or B, since it names nobody.
Parity direction: **B** closes the difference — it is the only option that makes Pi, claude and codex export
the same attribute set. **A** keeps them uniformly silent, which is honest but leaves codex's own pinned-off
switch as a capability the product refuses on the user's behalf.

### [host] May an ambient shell variable make a session export its whole conversation?

*Closes ledger cell **M34** (pi `absent`, claude `have`, codex `absent`).*

One variable name, three answers. All four content opt-ins live in the shipped claude binary
(`OTEL_LOG_USER_PROMPTS` 8, `OTEL_LOG_TOOL_DETAILS` 6, `OTEL_LOG_TOOL_CONTENT` 6, `OTEL_LOG_RAW_API_BODIES` 5,
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` 3, control 0) and reach the child unfiltered, because
`buildClaudeSubprocessEnv` spreads `process.env` (`packages/shared/src/agent/options.ts:250`) — so an ambient
`OTEL_LOG_RAW_API_BODIES=1` exports the whole conversation today, with no host decision anywhere. Codex is
pinned the other way: `log_user_prompt = false` is written unconditionally
(`packages/codex-responses-adapter/src/config-writer.ts:2506-2522`, `:2595`). Pi and the host have no reader at
all (`otlp-telemetry.ts:39-42`, `usage-metrics.ts:44-51`). The claude cell reads `have` on the vendor's binary
plus the page — that verdict survives; the question is whether the fork keeps it.

- **A — strip the four `OTEL_LOG_*` opt-ins from the claude child and keep codex pinned off** — buys: uniform
  silence on all three runtimes, no conversation content leaves the machine on an inherited variable, and the
  divergence a switch would otherwise carry disappears — costs: an operator who legitimately wants content in
  their own collector cannot have it on any runtime, and we remove a working vendor capability.
- **B — honour them on all three behind one host setting** — buys: parity, the documented behaviour, and one
  place where the decision is visible and auditable instead of an inherited environment — costs: conversation
  content, including raw API bodies, leaves the machine; the host must also implement the cap
  (`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`) on the two runtimes that have none.

Recommendation: **A**, on the owner's own recorded pattern: where a capability exists on one runtime only,
removal or refusal has been chosen every time (plan lines 43-45). If content export is wanted later, it should
arrive as B's explicit host setting and never as an inherited variable.
Parity direction: **B** closes the difference upward, **A** closes it downward. Both are uniform; only the
status quo is not.

### [host] May a desktop app open a metrics scrape socket?

*Closes ledger cell **M40** (pi `absent`, claude `absent`, codex `absent`).*

Host-side exporter, so tier 2: one implementation serves all three, and no runtime supplies it — the codex
binary's `[otel]` writer emits the log signal only. At HEAD `prometheus` scores 0
(`packages/shared/src/telemetry/usage-metrics.ts:556-574` builds an OTLP `resourceMetrics` payload and nothing
else) and the selector is read only as a hard disable (`:462` `otelExporterDisabled(env,'OTEL_METRICS_EXPORTER')`,
docblock `:14-15` "Honored as a hard disable, opt-in or not"). The split is already recorded by cost:
`docs/superpowers/plans/2026-07-29-observability-and-cost.md:186` — "Ours is otlp-or-nothing … A console
exporter is cheap; a Prometheus scrape endpoint is a listening socket in a desktop app and wants its own
decision."

- **A — implement `console`, refuse `prometheus` by name** — buys: the debugging half at near-zero cost, no
  inbound socket on any user's machine, and a named refusal so an operator learns why instead of meeting
  silence — costs: the page's `prometheus` value stays unmet, and a Prometheus-only shop gets nothing.
- **B — add the listening scrape endpoint too** — buys: full parity with the documented selector — costs: an
  inbound listening port on every machine that enables it, with its own bind-failure, port-collision and
  exposure story in a desktop app.

Recommendation: **A**, with **B** on demand — the same split the record already made.
Parity direction: both options are uniform across the three runtimes because the exporter is ours; **B** is the
one that closes the difference against the documented selector.

Note on scope: the `console` value in this question is the HOST exporter's own output and is distinct from
denominator **M21**, which is the opposite direction — refusing a `console` exporter to the claude CHILD,
whose stdout is our message transport. M21 needs no owner input and is written as a tracker row.

### N#0

# Group N — Cross-session messaging — owner questions (slice 1 of 1, entries 1–8 of 8)

Two questions, both new. Dedupe measured, not assumed:
`grep -a '^### \[' docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` → 27 headings, none about
cross-session messaging; that file's own `### N — N. Cross-session messaging` section (lines 1212–1218 and
1418–1443) says in terms *"No cell in this section is class OWNER, so there is no question to put to the sitting"*
— true of the N1–N3 cells it was written about, and N10/N11 did not exist when it was written.
`grep -a '^#' docs/superpowers/specs/2026-09-04-owner-sitting.md` → 22 headings (§1.1–1.9, §2.1–2.3, §3.1–3.4,
§4.1 + appendix), none concerning cross-session messaging, local IPC or cross-machine reach.

---

### [host] Let a hook or a Bash command post a message into its OWN session?

Closes ledger **N10** (proposed) — `[pi]` `[claude]` `[codex]`, all three `absent`, delivered once by the host.

Today a script the agent launched has no way back into the turn that launched it. The page documents a per-session
inbox socket for this; the vendored bundle does not export it — `CLAUDE_CODE_MESSAGING_SOCKET` scores 0 on both
0.3.223 and 0.3.233, against live controls `disallowedTools` 45 and `bypassPermissions` 157 on the same binary —
so there is nothing to inherit, and codex has no equivalent. **REFUTED 2026-09-11 by the lift to `0.3.247`:
`CLAUDE_CODE_MESSAGING_SOCKET` scores 17 in the native binary and `CLAUDE_CODE_MESSAGING_TOKEN` 12, both
still 0 in `sdk.d.ts` and 0 in `sdk.mjs`** (`grep -aoF`, negative control `nessyNotARealSdkKey` → 0 on
each), so the subsystem is in the artefact and almost entirely outside the declared types. What arrived is
not one variable but a whole native ingress — the env pair, a session registry keyed on the socket path, a
`udsInboxShape` and framed `notify_when_idle` diagnostics (P7.17). There is now something to inherit, and
the question below is therefore a live three-way choice rather than a choice between building and not
building; codex still has no equivalent. Our sessions live inside ONE host process reached by
RPC, so the natural host mechanism is an RPC endpoint, not a Unix socket per session. The admission entry point
already exists: `SessionManager.admitAgentMessage` (`packages/server-core/src/sessions/SessionManager.ts` symbol `admitAgentMessage`).
The whole question is a posture, not a mechanism: this is a NEW authority boundary — an inbound path into a live
session's turn from an unprivileged local process.

- **(a) No new local IPC surface** — buys: zero new authority boundary, no token to leak, nothing new to audit —
  costs: the documented hook→session feedback path entirely; a long-running script can still only report by
  exiting, so anything it learns mid-run is lost.
- **(b) An RPC endpoint on the EXISTING session token, own-child only, routed through `admitAgentMessage`** so
  N2's accept/hold/refuse ladder applies unchanged — buys: the capability inside a boundary we already audit, with
  the loop, rate and size guards of P6.45/P6.46 already in front of it — costs: one new authenticated endpoint and
  its own-child check, which is the part that must not be got wrong.
- **(c) A per-session Unix socket mirroring the page's spelling** — buys: literal fidelity to the documented shape,
  so a hook written for Claude Code works unchanged — costs: a second transport beside our RPC, a socket path and
  token on disk per session, and a lifecycle to clean up on crash — for a variable the runtime we vendor does not
  actually export. **That last clause is dead as of 0.3.247 — the variable IS exported now (see the
  refutation above), so (c)'s cost is no longer "fidelity to a shape nothing implements".** Its cost is
  that the binary's own refusal text scopes the ingress to Claude sessions, so mirroring the spelling buys
  back a claude-only divergence on a host rung that is one choke point for three runtimes. A different
  cost, not a smaller one — and the first time the share-vs-split rule's *"a split needs a MEASURED native
  mechanism"* is satisfied on this question.

**Recommendation: (b).** It is the smallest honest thing: no new transport, no new secret, and the existing
admission ladder is the audit surface. **Parity direction:** (b) closes the difference — all three runtimes gain
the capability at once from one host endpoint, so the switch verdict stays UNIFORM. (a) leaves the gap open but
leaves it HONEST only if the capability descriptor says so. (c) closes it and buys a divergence back, because the
socket exists on our sessions and on nothing the runtimes themselves provide.

**Evidence:** `git grep -anI 'CLAUDE_CODE_MESSAGING_SOCKET\|CLAUDE_CODE_MESSAGING_TOKEN' -- ':(glob)packages/**'
':(glob)apps/**'` → exactly ONE hit, and it is a COMMENT recording the absence:
`packages/server-core/src/sessions/cross-session-inbound.ts:43`. Re-run 2026-09-11 the same probe answers
THREE hits, all in that one file and all still comment: the block now records the reversal beneath the
sentence cited here, which is the artefact a reader of this question should open first. Plan row P6.45's own native-first probe drove the
vendored bundle with the controls quoted above. Source page: `cross-session-messaging`.

---

### [host] Build host-relayed cross-machine session messaging, or say same-machine only in writing?

Closes ledger **N11** (proposed) — `[pi]` `[claude]` `[codex]`, all three `absent`, one host decision.

The page advertises reaching one of your sessions on another machine, or on Claude Code on the web, addressed by
name like a local session. Its own route needs a claude.ai sign-in plus Remote Control, and the page **excludes
our case explicitly** (`cross-session-messaging.md:333`); codex has no session-to-session tool at all; there is no
Remote Control client anywhere in this tree. We own a server, so a relay is buildable — but nothing is native to
adopt, and this changes **what leaves the machine**, which is section C's own subject.

- **(a) No — same-machine only, said plainly in the capability descriptor and the switch report** — buys: zero new
  egress path, no new credential surface, and an honest divergence instead of a silent one — costs: the
  cross-machine coordination the page advertises, on all three runtimes.
- **(b) Relay via our gateway, with approval on** — buys: parity with the page as written — costs: a new egress
  path carrying session TEXT (not just tokens), plus an account dimension `sessionId` does not carry today, so the
  addressing scheme itself has to grow before the relay can exist.

**Recommendation: (a)**, consistent with section C's posture. **Parity direction:** (a) does NOT close the
difference against the page — it makes the residue HONEST, which is the host's job when the answer is "we
decline"; it is only a closed row if the descriptor and the switch report actually name it, so (a) carries a
`BUILDABLE S` surface obligation with it. (b) is the option that closes the difference, and it should not be taken
on this row alone — it is a section C decision wearing a section N hat.

**Evidence:** `packages/session-tools-core/src/handlers/send-agent-message.ts:5-8` — args are `{ sessionId,
message }`, with **no machine or account dimension** (verified at HEAD `34be43fde`). Delivery resolves the target
inside the sender's own Workspace and throws otherwise:
`packages/server-core/src/sessions/SessionManager.ts` symbol `deliverAgentMessage`, verbatim *"a target session ID resolves only
inside the sending session's Workspace"*. Source page: `cross-session-messaging`.

---

### O#0

# Owner questions — denominator group O (Notifications, UI, accessibility), entries O7–O21

Slice 1 of 1. Three of the fifteen entries are OWNER; **all three are already asked or already ruled**, so this
file opens no new question. The remaining twelve are two promotions and nine tracker rows in
`rows-O-0.md`.

## Slice notes carried over

Section bodies from the slice files that are neither a question nor an already-asked pointer, kept verbatim.

### B#0 — Note — standing rulings behind three of these (cross-reference only, not a placement)

Denominator B12 and B17 carry standing rulings (`2026-07-29-deviation-audit.md:193`; R50, owner 2026-08-08)
and are asked above only as confirm-or-reopen — if the owner declines to revisit, both close on their
existing ruling with no code. Denominator B32 (`managedSourcesBehavior: "merge"`) is NOT a question at all:
P3.290 (`ae9b1c07a`) already decided to refuse it at parse and the refusal is legible
(`managed-policy.ts:1193-1198`); it is placed under `## Structural` in `rows-B-0.md`.
