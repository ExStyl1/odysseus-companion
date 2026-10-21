# What `whats-new/2026-w30` and `2026-w32` contained, against this tree

Read 2026-08-22. Both pages fetched with `curl -s -L` and read whole (91 and 103
lines). Unlike the 2026-07-29 pass, which filtered 17 pages for six words, this
one takes **every** feature the two weeks announce — 14 in w30, 16 in w32 — and
answers "do we have it" with a `file:line` or a measured absence plus a positive
control on the same rig.

Bundle context, stated once: `@anthropic-ai/claude-agent-sdk` is pinned at
`0.3.223` in three manifests (the `@anthropic-ai/claude-agent-sdk` dependency entry of
the root `package.json`, `packages/core/package.json` and `packages/shared/package.json`). Version gates in these pages are CLI/Desktop
versions (`v2.1.219`, `v2.1.224`, Claude Desktop `v1.24012.0`), not SDK versions,
so "requires vX" lines are **за пределами нашего бандла** and are marked as such
rather than filed as gaps.

**Method trap paid immediately.** `apps/electron/resources/pi-agent-server/index.js`
and `.../session-mcp-server/index.js` are gitignored build artifacts
(`.gitignore:11-12`, 27 MB and 7.8 MB, `git ls-files` refuses them). A first
grep pass "found" `emojiCompletionEnabled`, `ListAgents` and `deep-research` in
this repo — all three hits were inside those bundles, i.e. inside third-party
code we ship, not code we wrote. Every probe below is scoped to
`packages/*/src apps/electron/src apps/cli/src scripts`.

**Method note on w31.** There is no week-31 digest to have missed:
`https://code.claude.com/docs/en/whats-new/2026-w31.md` returns **404**, and
`llms.txt` lists exactly `whats-new/2026-w30` and `whats-new/2026-w32` in the
`w3x` range. The index is complete, not stale.

---

## The finding: our cross-session message carries user authority

`whats-new/2026-w32.md:20`:

> Your Claude Code sessions can now message each other. Claude discovers your
> other sessions with the `ListAgents` tool and sends with `SendMessage` … **A
> message is text Claude writes for the other session, never your conversation
> history or files.**

Three things came apart here.

**1. The coverage map's evidence for this page is factually wrong.** Row 175
(`cross-session-messaging`, 🟨) reads "код есть (40 файлов, 7 с тестами —
`SendMessage` в `session-tools-core/tool-defs.ts`, `shared/agents/definitions.ts`)".
Measured on those exact two files:

| Probe | `session-tools-core/src/tool-defs.ts` | `shared/src/agents/definitions.ts` |
| :-- | --: | --: |
| `grep -a -c "SendMessage"` | **0** | **0** |
| `grep -a -c "name:"` (positive control) | 64 | 12 |

Every `SendMessage` hit in this repo is our RPC channel for the **user's own**
message — `packages/server-core/src/handlers/rpc/sessions.ts:445`
(`RPC_CHANNELS.sessions.SEND_MESSAGE`). The map's code probe matched a
same-named, unrelated symbol. That is the fourth shape in
`…specs/2026-07-29-inert-worklist.md` §3 ("same-named symbols in a sibling
subsystem"), scoring a page 🟨 instead of measuring it.

**2. We do have the feature, under different names.** `send_agent_message`
(`packages/session-tools-core/src/tool-defs.ts:1117`, handler
`packages/session-tools-core/src/handlers/send-agent-message.ts`) is
`SendMessage`; `list_sessions` (`tool-defs.ts:1100`) is `ListAgents`. There is
no `/list-agents` equivalent (`grep -a -rl "list-agents"` over our source → 0
files; positive controls `disableBundledSkills` → 11, `enforceAvailableModels`
→ 11, `askUserQuestionTimeout` → 16 files).

**3. Both halves of the page's contract sentence are violated.**

*Files.* `SendAgentMessageArgs.attachments` (`send-agent-message.ts:5-9`) accepts
`{ path, name }[]`; `SessionManager.ts:15224-15244` path-validates each against
the workspace allowlist and builds real `FileAttachment[]`. A message here CAN
be files.

*Authority.* `SessionManager.ts:15245` delivers with:

```
await this.sendMessage(sessionId, message, fileAttachments, undefined, undefined, undefined, undefined, undefined, { workspaceId: managed.workspace.id })
```

That is the **identical method** the user's own RPC path calls
(`rpc/sessions.ts:445`), and its own doc-comment at `SessionManager.ts:18347-18350`
describes the payload as "the **user message** … pushed to `managed.messages` and
persisted to disk". The only marker of agent origin is a textual prefix the
handler prepends (`send-agent-message.ts:35-42`):
`[Message from session "<id>" (<name>)]` — text inside the untrusted body, not a
trust boundary. Sending is gated in Safe/Explore (`tool-defs.ts:1117`
`safeMode: 'block'`); **receiving has no gate at all.**

This closes a row the previous pass could not.
`2026-07-29-weekly-changelog-findings.md:98` recorded w24's "Messages relayed via
`SendMessage` from other sessions **no longer carry user authority**" as
"**not re-checked.** The row itself says this needs a real trace, not a grep."
This is that trace. The authority is carried. w32 now makes it a documented
contract on a page of its own, so it is no longer inference from a changelog line.

---

## Week 30 — every feature

### Headline 1 — Claude Opus 5 becomes the default Opus model

> `w30.md:20`: "Claude Opus 5 is the new default Opus model in Claude Code…
> Opus 5 runs with a 1M-token context window… Fast mode moves to Opus 5 at
> \$10/\$50 per MTok. Requires v2.1.219 or later."

**Half of it is already ours, and the half that is missing is the catalog.**
`packages/shared/src/agent/thinking-levels.ts:279` matches
`/claude[-.](fable-5|opus-5|sonnet-5|opus-4-8|opus-4-6|sonnet-4-6)/i` → `high`,
and `:305-312` deliberately **excludes** Opus 5 from the `:455` effort-hold list
with a comment saying so ("Opus 5 and Sonnet 5 are in the first list and
deliberately absent from this one — merging them is the mistake this comment
exists to prevent"). So the effort tables are current with `model-config.md`.

The model catalog is not. `packages/shared/src/config/models.ts:142-198`
(`MODEL_REGISTRY`, "the authoritative list - all other model arrays derive from
this") contains `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`,
`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-fable-5` — **no
`claude-opus-5`**. `packages/shared/src/config/llm-connections.ts:811` still
heads `PREFERRED_DEFAULTS.anthropic` with `claude-opus-4-8`.

1M context has a mechanism but nothing to apply it to: `models.ts:153,162,171,198`
already carry `contextWindow: 1_000_000`, and
`packages/shared/src/unified-network-interceptor.ts:1022-1025` strips the
`context-1m-2025-08-07` beta header when the setting is off. Adding an Opus 5
entry is a catalog edit, not a wire change.

Fast-mode pricing: not our surface — map row 10 (`fast-mode`, ⬜) already records
that our `shouldEnableFastMode` (`unified-network-interceptor.ts:534`) is
gateway fast-model selection, not Claude's `/fast`.

"Requires v2.1.219" — **за пределами нашего бандла.**

### Headline 2 — iOS Simulator pane in Claude Code Desktop

> `w30.md:41`: "Claude Code Desktop on macOS gets an iOS Simulator pane…
> Requires Xcode with the iOS platform installed, and Claude Desktop v1.24012.0
> or later."

Absent and correctly absent. `grep -a -rln "simctl|iOS Simulator|iosSimulator"`
over `apps/electron/src packages/*/src` → **0 files**; positive control
`browser_tool|browserPane` on the same rig → 3 files, so the rig sees panes.
`apps/ios/` is our own companion mobile client (`NessyAgentKit`, `NessyMobile`),
an unrelated product. Map row 130 (`desktop-ios-simulator`, ⬜) holds. Version
gate is on **their desktop app** — за пределами нашего бандла.

### Headline 3 — Claude Security plugin

> `w30.md:62`: "The Claude Security plugin runs a multi-agent vulnerability scan
> of your codebase inside a Claude Code session… writing the report to a
> `CLAUDE-SECURITY-<timestamp>/` directory."

Not bundled — but map row 85's flat "нет" understates what we measured. Our
Claude plugin **format adapter was built against this exact plugin**:
`packages/shared/src/plugins/format-adapters/claude.ts:972` ("the official
`claude-security` plugin writes…") and
`packages/shared/src/plugins/__tests__/frontmatter-splitter.test.ts:4,13-14`
("Measured against the signed 1.25.0 on the official `claude-security` plugin",
with its real `Agent(claude-security:scan-inventory, claude-security:scan-researcher, …)`
declaration as the fixture). So `/plugin install claude-security@claude-plugins-official`
is a supported install path in this fork, verified against the real artifact —
what we lack is a bundled equivalent, not a loader gap.

### Other wins, w30

**`/code-review` as a background subagent** (`w30.md:77`). We have the tool, and
the deviation is recorded at the call site.
`packages/pi-agent-server/src/orchestrator/review-tool.ts:443-449`:

> DEVIATION, recorded not accidental. `code-review.md:336` — "The review runs in
> the background by default" with three named foreground fallbacks (:338-:340).
> We are always in the fallback: `review` is a tool call whose findings must
> return in ITS OWN result, and backgrounding it would change what a caller
> receives, not just when.

`background: false` at `:449`. Deliberate, with the page cited.

**`/verify`, `/code-review`, `/deep-research` no longer self-launch**
(`w30.md:78`). Ours for the one we ship:
`apps/electron/resources/skills/code-review/SKILL.md:4` carries
`disable-model-invocation: true`, and the loop skill states the rule from the
other side (`skills/loop/SKILL.md:94`: "skills marked
`disable-model-invocation: true` … reach you as plain text instead of
executing"). `/verify` and `/deep-research` are not shipped:
`grep -a -rl "deep-research|deepResearch"` over our source → 0 files (positive
control `skill-creator` → 4 files). Our bundled set is four skills:
`code-review`, `loop`, `plugin-creator`, `skill-creator`.

**Emoji shortcodes / `emojiCompletionEnabled`** (`w30.md:79`). 0 files in our
source (positive controls above). Worth one line beyond "no": the identifier IS
in the SDK we ship — `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6460`
`emojiCompletionEnabled?: boolean;` — so this is another knob we bundle and never
read, the `memoryType`/`suppressOutput`/`terminalSequence` shape the coverage map
warns about. Renderer-input feature; low value, cheap to note.

**Skills with `context: fork` run in the background by default** (`w30.md:80`).
**Landed.** `packages/shared/src/capabilities/runtime-skill-content.ts:1356`:
`background: skillFrontmatterBoolean(frontmatter.background) ?? true`. The field
is admitted by the reader at `packages/session-tools-core/src/validation.ts:224,288`
("`background` chooses whether the invoking turn waits for it, so both are now
read"), and both arms are bounded at `packages/shared/src/agent/pi-agent.ts:7104`
— 60 s admission for a background fork, 30 min for a `background: false` one that
"owes its result to this turn (`:571`)".
`packages/pi-agent-server/src/orchestrator/skill-fork.ts:60` cites `skills.md:269`
by line.

**20 concurrent subagents, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`** (`w30.md:81`).
**Landed, with a reconciliation worth reading.**
`packages/shared/src/config/subagent-limits.ts` quotes `sub-agents.md:898` and
`env-vars.md:277` verbatim, maps the Claude env name to
`NESSY_MAX_CONCURRENT_SUBAGENTS`, and narrows the documented 20 by machine memory
so the host's live-agent ceiling
(`packages/server-core/src/sessions/live-agent-ceiling.ts`) can never refuse
first with a differently-worded error. The module states the invariant:
`maxConcurrentSubagents() < resolveLiveAgentCeilingFor()`.

**`--max-budget-usd` now enforces the cap on subagents** (`w30.md:82`). **Not
ours.** `maxBudgetUsd` is a session-level abort only:
`packages/shared/src/agent/pi-agent.ts:7637,7651-7664` yields
`terminalReason: 'max_budget_usd'` and `forceAbort(AbortReason.MaxBudgetUsd)` on
the parent's own event stream. `grep -a -rn "MaxBudgetUsd|maxBudgetUsd"` over
`packages/pi-agent-server/src/orchestrator/` and
`packages/server-core/src/pi-harness/` → **0 hits**; positive control
`limitScope` in `spawner.ts` → 4 hits. A running background subagent is not
stopped by the cap, and a new one is not refused by it.

**`sandbox.filesystem.disabled`** (`w30.md:83`). **Landed.**
`packages/shared/src/config/sandbox-settings.ts` parses `filesystemDisabled` and
merges it at `:862-875` with the safe polarity (disabled only when no layer says
`false` and some layer says `true`); enforcement in
`packages/server-core/src/pi-harness/isolation.ts` with a dedicated test file
`packages/server-core/src/pi-harness/isolation-filesystem-disabled.test.ts`.
Network egress control survives, as the page requires.

**Auto mode stops opening dialogs for dangerous `rm`, background jobs, and
suspicious Windows paths** (`w30.md:84`). **Not ours, and deliberately so — this
is a changed default that needs an owner call, not a bug.**
`packages/shared/src/agent/core/pre-tool-use.ts:1187-1201` keeps the removal
circuit breaker as an unconditional prompt, quoting `permissions.md:58`/`:63` and
`permission-modes.md:401`, and says explicitly:

> unlike EVERY other gate in this file it is NOT skipped by `allow-all`: a
> permission mode is a statement about how much the user wants to be asked, not
> a licence for a model error to delete their home directory.

Our classifier's remit is narrower by design:
`packages/shared/src/agent/core/guardian-consult.ts:1-27` consults the judge
**only** for the BORDERLINE band ("the exact set that resolves to ASK today"),
and every failure mode — missing port, disabled setting, open circuit, `unsure`
verdict — "fail-closed to a human, never to auto-run". Upstream has now widened
the classifier to adjudicate what we hold as a hard gate.

**Bash permission checks fail closed on more shell forms** (`w30.md:85`).
**One of four.**

| Form the line names | Ours |
| :-- | :-- |
| commands over 10 000 characters | **have it.** `packages/shared/src/agent/pi-harness/claude-bash-rule.ts:42` `MAX_COMMAND_LENGTH = 10_000`, documented at `:32-36` against `permissions.md:210` |
| file-descriptor redirects | **not as a fail-closed rule.** `claude-bash-rule.ts:172` only decides that `2>&1` and `&>` do not *separate* segments — a tokenizer decision, not a refusal |
| Zsh variable subscripts in `[[ ]]` | **absent.** The only zsh mention across the harness is `permission-dsl.ts:573` (`['bash','zsh','sh']` + `-c`/`-lc`) |
| `help` and `man` invocations that could run unsafe options | **absent.** `grep -a -n "'man'\|\"man\"\|'help'\|\"help\""` over `packages/shared/src/agent/pi-harness/*.ts` → 0 hits; positive control `'watch'` in `claude-bash-rule.ts` → 1 hit |

Same family as S3 from the previous pass: rules that look enforced and are not.

**Fast mode drops Opus 4.7** (`w30.md:86`). Not our surface (row 10 ⬜). Recorded
so the next reader does not re-file it.

**Periodic progress heartbeat for long-running tool calls** (`w30.md:87`).
**Not ours.** We have a *push* bridge, not a timer:
`packages/pi-agent-server/src/local-tools/tool-wrapper.ts:34`
`createPiToolProgressBridge()` emits only when the tool itself calls `emit`.
`grep -a -rn "setInterval"` over `packages/pi-agent-server/src/local-tools/`,
`packages/shared/src/agent/pi-harness/tool-executor.ts` and
`.../execution-receipt.ts` → **0 hits**; positive control `setInterval` in
`packages/server-core/src/transport/` → 3 hits (including `server.ts:137`
`heartbeatTimer`, the WebSocket keepalive — a different heartbeat, and the exact
similar-named-counter trap). A silent tool stays silent here.

---

## Week 32 — every feature

### Headline 1 — Cross-session messaging

See the finding above.

### Headline 2 — Self-hosted environments

> `w32.md:43`: "Self-hosted environments run Claude Code cloud sessions on your
> organization's own infrastructure, in public beta on Team and Enterprise
> plans. Run `claude self-hosted-runner` on your machines…"

Absent, and the verdict already exists.
`grep -a -rl "self-hosted-runner"` and `"selfHosted"` over our source → **0
files each** (positive controls above); the identifier is also absent from the
bundled SDK (`grep -a -c` over `node_modules/@anthropic-ai/claude-agent-sdk/` →
0), so it is CLI-side, **за пределами нашего бандла**. Map rows 180-186 record
the decision ("хостируемый ярус исполнения — то же решение, что по cloud
sessions: наша ниша local-first"). Public-beta promotion changes nothing.

### Headline 3 — Auto mode becomes the default permission mode

> `w32.md:66`: "Starting August 14, auto mode is the default permission mode for
> new sessions on Pro, Max, and Team plans… Already in effect on those plans:
> the classifier calls auto mode makes no longer count toward your usage limits."

**Not ours, and this one is a product decision the owner should make.**
`apps/electron/resources/config-defaults.json:23` ships
`"permissionMode": "explore"` — read-only Safe mode — with
`cyclablePermissionModes: ['explore','plan','default','acceptEdits','auto']`. So
`auto` exists and is reachable; it is not where a new session starts. Managed
policy parses `defaultMode` (`packages/shared/src/agent/pi-harness/managed-policy.ts:1527-1530`,
citing `settings.md:385`) and `:636` allows it to name "a MORE permissive mode
than the app's default", so an organisation can already opt in.

### Other wins, w32

**VS Code Focus view** (`w32.md:87`). Not our surface; map row 156 ⬜ holds.

**Sandbox credential files accept `mode: "mask"`, plus `extract`, JWT `decode`,
AWS SigV4 re-signing** (`w32.md:88`). **Absent, and the gap is architectural
rather than a missing field.** `sandbox.credentials` appears **once** in our
source and it is a doc comment: `packages/shared/src/config/sandbox-settings.ts:515`
("This is `settings.md:200`'s `sandbox.credentials` row applied to the sub-block
we actually have" — i.e. `network`). Positive control on the same rig:
`deniedDomains` → 6 files including 16 hits in `sandbox-settings.test.ts`.
`extract`, `decode`, `SigV4`, `mode: 'mask'` → 0 hits each.

Our posture is the *opposite* one and is enforced: a host-composed credential
**deny** floor that no settings layer can release
(`sandbox-settings.ts:1093-1108` — "The host credential deny floor is RETAINED
with the layer off: it is composed in the isolation funnel, not from a settings
file, so no settings layer releases it"). Masking is strictly more permissive
than denying — for a bank fork that is a decision, not a port.

**Marketplace `archive` source with optional SHA-256 pin** (`w32.md:89`).
**Half.** The download half exists: `packages/shared/src/plugins/source-resolver.ts:462`
returns `{ type: 'archive-url', url, expectedHash }`, consumed at
`packages/shared/src/plugins/acquisition.ts:393`, with real sha256 verification
at `acquisition.ts:963-964` (`/^sha256:([0-9a-f]{64})$/i` compared against
`createHash('sha256')`). What is missing is the **marketplace entry source
kind**: our classified kinds are `'url' | 'repository' | 'local-path' |
'unsupported'` (`packages/shared/src/plugins/types.ts:37-39,131`) — there is no
`archive`. So a marketplace that adopts the new source shape is unresolvable
even though the machinery behind it is already built and tested.

**`/review` is now an alias of `/code-review`; no effort level reuses the last
one** (`w32.md:90`). Alias: **absent** — `grep -a -rl "/review\b"` finds no
alias mechanism, and the only `alias` mentions in `packages/shared/src/skills/storage.ts:114,233`
are unrelated. Effort reuse: **partial and already recorded as a deviation**.
`review-tool.ts:435-441`:

> The sticky half of `:327` — reusing the last level the USER typed, across
> sessions — has no store in this fork and is a recorded deviation; the bundled
> skill reuses it within the conversation instead.

Implemented as prose in `apps/electron/resources/skills/code-review/SKILL.md:39-45`
("`/code-review` runs in this conversation unless they type a different one…
When the user has never typed a level in this conversation, omit `effort`
entirely"). Conversation-scoped, not cross-session.

**`/fork` makes its code changes in a worktree of its own** (`w32.md:91`).
**Opt-in, not default.** `docs/architecture/fork-subagents.md:208-219` records
R29b closing `:1048` ("a fork can be spawned with `isolation: \"worktree\"`"):
the `subagent` tool advertises `isolation` under FORK MODE ONLY, `spawnChildSession`
forwards it into `composeForkRestrictions`, "so a fork requesting an isolated
worktree is admitted and gets a lease". Upstream has now made that the default;
ours stays per-call.

**Plugins installed from `/plugin` activate in the current session; the summary
reports `Plugin is now active.`** (`w32.md:92`). **Not ours, and we say so in
two places.** `apps/electron/src/renderer/pages/plugin-update-affordance.tsx:19-24`
quotes `plugins/cli-reference.md#reload-plugins (was line 703 of the retired plugins-reference page)` and names the substitute: "This fork's
equivalent action is Plugins → Refresh runtime, which `plugins.autoUpdateNoticeBody`
names" (`packages/shared/src/i18n/locales/en.json:1201`).
`packages/server-core/src/handlers/rpc/marketplace-auto-update.ts:18` states it
flatly: "this fork has no `/reload-plugins` command". The new upstream behaviour
adds a *third* state — automatically active — that our install summary has no
word for.

**Background sessions commit and push before finishing, open a draft PR when the
task calls for one, follow `CLAUDE.md` git instructions** (`w32.md:93`).
**Absent.** `grep -a -rn "git push|commitAndPush|draft pull request|draft PR"`
over `packages/*/src apps/electron/src` returns only test fixtures using
`git push` as a permission-rule *sample*
(`packages/server-core/src/pi-harness/permission-events-composed.test.ts:140`,
`packages/shared/src/plugins/__tests__/hooks-automation.test.ts:1264`); positive
control `git worktree` → 3 source files. Nothing commits or pushes on a
background session's behalf. The draft-PR half is doubly blocked: there is no
GitHub surface, which `review-tool.ts:44-48` already measured for its own PR
target ("`grep -a` for `gh pr`, `pull request comment` and `createReviewComment`
over `packages` and `apps` is empty").

**The 200-subagent-per-session cap is removed** (`w32.md:94`). **No-op — we never
had one.** `grep -a -n "200"` in `subagent-limits.ts` and `spawner.ts` returns
only `env-vars.md` output-length quotes. What upstream *kept* — the concurrency
limit and the depth limit — is exactly what we implement
(`subagent-limits.ts`, `subagent-spawn-depth.ts`). Nothing to do; recorded so it
is not re-filed.

**Checked-in repo settings can no longer turn on Remote Control auto-connect;
`remoteControlAtStartup` moves to user/managed settings** (`w32.md:95`). Not our
surface — 0 hits in our source, and map row 100 (`remote-control`, ⬜ "нет")
holds. One note: the field is in the SDK we ship
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6702`
`remoteControlAtStartup?: boolean;`) — a second shipped-but-unread knob beside
`emojiCompletionEnabled`.

**Worktree isolation now blocks Bash commands and git redirects, not only file
edits, in every session type and in subagents** (`w32.md:96`). **Not ours, and
the fork's own recorded reason for the narrower version just got weaker.**
`packages/shared/src/config/worktree-settings.ts:8-16`:

> Claude documents `"worktree"` as the default, and it "blocks `Edit`/`Write` in
> the main checkout until `EnterWorktree` is called". We ship the key with the
> documented value available and `"none"` as OUR default… adopting `"worktree"`
> here would refuse the first edit of every existing session in this fork, and
> the release valve is a Pi-only tool, so a Claude- or Codex-backed session
> would meet a block it has no way to lift.

Enforcement scope is stated at `packages/shared/src/agent/core/pre-tool-use.ts:785-789`:
"`'worktree'` blocks `Edit`/`Write` in the main checkout until the session enters
one; absent or `'none'` is our default and changes nothing." Bash and git
redirects are outside it. Merge polarity is already correct for widening
(`worktree-settings.ts:186` — "tighter wins").

**A Bash command can no longer hide part of itself from permission checks; tab
or invisible-Unicode padding no longer hides part of a command from the approval
dialog** (`w32.md:97`). **Flagged, not asserted.** Our invisible-character
machinery is scoped to untrusted *reports*, not to the approval dialog:
`packages/shared/src/prompts/untrusted-text.ts:32` `ZERO_WIDTH_SPACE = '​'`
is *inserted* to break marker tokens in subagent output
(`review-tool.ts` defangs "AFTER the parse"). No probe found a normalization step
applied to the command string before it is rendered for approval. Per the
measured-traps rule that "a live case's DETECTOR is the thing most likely to be
wrong", the honest state here is **unchallenged**, not confirmed-absent: the
right instrument is a live CDP case that types a padded command and reads what
the dialog shows, and a grep cannot stand in for it.

**PreToolUse auto-allow hooks no longer bypass tool restrictions in internal side
tasks such as summaries and compaction** (`w32.md:98`). **Not ours — we have no
notion of an internal side task in the permission path.**
`grep -a -rln "sideTask|side task|internal task|isInternal"` over
`packages/shared/src/agent` → **0 files**; `grep -a -n "compaction|summariz"` in
`pre-tool-use.ts` → 2 hits, both about context *delivery*
(`:817-819`, the once-until-compaction dedup), neither a task class. So a
PreToolUse hook that auto-allows applies uniformly, including to whatever
internal work runs the same gate. Same family as S3: a bypass that only shows up
once you ask which caller is on the other side.

**Ultraplan removed** (`w32.md:99`). **Consistent already.** 0 hits for
`ultraplan` in our source; map row 103 already carries "Страница удалена из
`llms.txt` 2026-08-09 — вердикт сохранён как история", and the bundled skill
refuses the keyword in words:
`apps/electron/resources/skills/code-review/SKILL.md:67-69` — "Cloud ultrareview
is not available here."

---

## Tally

| | w30 | w32 |
| :-- | --: | --: |
| landed, verified this pass | 3 | 0 |
| landed as a recorded deviation | 1 | 3 |
| absent, decision already recorded | 3 | 4 |
| absent, no verdict anywhere — new gap | 5 | 6 |
| not our surface / за пределами нашего бандла | 2 | 3 |

The five w30 gaps: `--max-budget-usd` on subagents; the three unimplemented Bash
fail-closed forms; the tool-progress heartbeat; auto mode's three moved checks;
emoji shortcodes. The six w32 gaps: cross-session message authority; credential
`mode: "mask"`; the `archive` marketplace source; `/review` alias; background
commit-and-push; PreToolUse in side tasks.

One of them is security-relevant and is the reason this pass was worth running:
`send_agent_message` delivering through `SessionManager.sendMessage` gives any
session's model a way to author a **user-authority** turn, with file attachments,
in another session. That is the same class of finding as S3 in the previous pass
— a control that reads as enforced from the outside, and is not.
