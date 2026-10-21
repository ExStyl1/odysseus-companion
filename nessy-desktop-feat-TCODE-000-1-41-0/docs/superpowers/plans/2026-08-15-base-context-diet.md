# Base-context diet + credential-store machine-id resilience

Status: DRAFT, ready to dispatch. **One plan, TWO INDEPENDENT LANES** (owner
decision 2026-08-15, merging three earlier drafts into this file):

- **Lane C — base-context diet.** Cut the ~70 000-token resting input a
  session spends before any history. Merged from
  `2026-08-15-base-context-diet.md` (the placeholder: measured breakdown,
  open questions, IPC-inventory tail chore) and `2026-08-15-context-diet.md`
  (an earlier draft: per-server attribution of the MCP row, the
  per-tool-cost framing, the "what is the FLOOR" question, per-runtime
  deltas naming Claude's preset and Codex's `externalStandaloneOnly`).
- **Lane K — credential-store machine-id resilience.** Merged from
  `2026-08-15-credential-store-machine-id.md`.

**The lanes share nothing.** No file, no package, no ordering dependency.
Lane C lives in `packages/shared/src/agent/pi-harness/`,
`packages/shared/src/prompts/`, `packages/shared/src/config/` and
`packages/pi-agent-server/`; lane K lives in
`packages/shared/src/credentials/`. Run them in either order or in
parallel; a defect in one does not block the other's close-out. They are
one file because the owner asked for one file, not because the subjects
touch. ONE close-out covers both (single version bump, one release-notes
entry with sections for each).

---

# LANE C — Base-context diet

## C.0 What this lane answers

Not "hit 15 000 tokens". The question is **how far down the resting base
can honestly go, and where the wall is**. For each block: what is
IRREDUCIBLE (a session cannot function without it), what is DEFERRABLE
(needed sometimes, loadable on demand), what is REMOVABLE OUTRIGHT (dead,
duplicated, or advertised-but-unused). Those three buckets with token
numbers ARE the deliverable; the descent curve and the floor fall out of
them.

## C.1 The measured baseline (do not re-derive)

Measured live 2026-08-15 from Pi's own `/context` accounting on the
owner's default connection, **after one real turn**. Recorded in
`docs/testing/cdp-live-checklist.md` § "Two facts lane F will need".

| category | tokens | share |
| --- | --- | --- |
| `system_tools` (built-in + session tool schemas) | 20 182 | 28.5% |
| `mcp_tools` (MCP-server tool schemas) | 20 078 | 28.4% |
| `system_prompt` | 19 351 | 27.3% |
| `custom_subagents` (claude-security's 7 agents) | 8 622 | 12.2% |
| `skills` | 1 048 | 1.5% |
| `conversation_messages` | 603 | 0.9% |
| `memory_files` | 0 | — |
| unaccounted | 939 | 1.3% |
| **total input** | **70 823** | |

**The measurement must come AFTER a turn.** A fresh session reads
`system_prompt` 0 and `mcp_tools` 0 — they are not composed yet — and the
total reads 28 415, understating by 60%. Any re-measure that skips the
turn is void.

**Consequence, proven live, not inferred.** A model with a real 40 960
window overflows on the FIRST turn: `400 {"message":"This model's maximum
context length is 40960 tokens. However, your request has 70042 input
tokens…"}`. The resting base decides model USABILITY, not how a meter
draws. That 70 042 is also the only INDEPENDENT number we have — the
endpoint's own count of what we sent — and it agrees with our accounting
to within 1.1%. It is the control C1 below is built on.

## C.2 Static reconciliation of the four blocks

Measured this session by direct read, not by re-running the live rig.
Estimator is the product's own: `estimateTokens = Math.ceil(len / 4)`
(`packages/shared/src/utils/large-response.ts:77`), so these numbers are in
the same unit as the `/context` rows.

### `mcp_tools` 20 078 — 89% attributed to ONE plugin

Read from the descriptor cache the session itself used,
`~/.nessy-agent/mcp/tool-descriptors/*.json`, taking the newest entry per
connection (both stamped 2026-08-15 08:41, the morning of the measurement):

| connection | tools | schema tokens | share of the row |
| --- | --- | --- | --- |
| `plugin_figma_figma` | 32 | **15 836** | 78.9% |
| `dpGitlab` | 11 | 2 124 | 10.6% |
| accounted | 43 | 17 960 | 89.5% |
| residual (unattributed statically) | — | 2 118 | 10.5% |

Worst single tools, all figma: `get_design_context` 1 082 ·
`get_screenshot` 983 · `export_video` 976 · `generate_diagram` 865 ·
`send_code_connect_mappings` 829 · `use_figma` 815. Average 494 tokens per
figma tool against 193 for dpGitlab.

**One installed plugin costs 22% of the entire resting base.** The residual
2 118 is not guessed at: the live adapted definitions carry the
`mcp__<wire>__` prefix on every name (the cache does not) and a less
compact schema serialization, and a third connection may have been live.
C1 settles it on the wire.

### `system_tools` 20 182

Measured by running the product's own projection:

| surface | tools | tokens |
| --- | --- | --- |
| session tools, `projection: 'pi'` | 52 | **12 902** (name+desc 6 493 · schema 6 416) |
| Pi built-in static bindings (residual) | 18 | **7 280** (≈ 404 each) |

The 18 are `STATIC_CHILD_BINDINGS`
(`packages/shared/src/agent/pi-harness/harness-manifest.ts:178`): read,
bash, bash_background, edit, write, grep, find, ls, NotebookEdit,
web_search, web_fetch, subagent, review, get_subagent_result,
steer_subagent, stopTask, workflow, ask_user — plus `mcp__tool_search` and
`mcp__tool_load`, which are dropped from the manifest when deferral is off
(`harness-manifest.ts:613-617`), which today it always is. The 7 280 is a
residual, not a direct read; C1 measures it.

### `system_prompt` 19 351 — half of it is tool descriptions, a second time

| component | tokens | how measured |
| --- | --- | --- |
| static base prompt, 38 sections | **9 327** | `bun run print:system-prompt`, 37 307 chars (independently re-run at 37 355 chars / 9 339 tokens) |
| `## Active Nessy tool contract` — 52 session tools | **3 942** | composer replay, 303 chars/line avg |
| `## Active Nessy tool contract` — 43 MCP tools | **3 313** | composer replay over the descriptor cache |
| `## Active Nessy tool contract` — 18 built-ins | ~1 400 | derived at the same avg |
| stable context parts | **~150** | `formatWorkspaceCapabilities()` collapses to a 73-char one-liner whenever the capability runtime is active — i.e. every real turn — plus 130–500 chars of working directory |
| accounted | ≈ 18 132 | |
| **residual** | **≈ 1 219** (6.3%) | not attributed statically; sits in the contract block's built-in third, whose 404-token average is a derivation, not a read. C1 closes it |

Two structural facts about this row that shape the tasks. **The prose half
is 84% constant** — roughly 31 500 of the 37 400 chars are byte-identical
for every session on every profile. And **the system prefix is identical
across all seven permission modes** by design: the mode-specific guidance
(`modeGuidance`) is a VOLATILE part on the user tail, deliberately, so a
mode switch does not re-stamp Pi's cache. Nothing in this plan may move a
volatile part into the prefix.

**The finding.** `composePiHarnessPrompt`
(`packages/shared/src/agent/pi-harness/prompt-composer.ts:15-31`) appends
one line per tool:

```
- <piName> (<effect>, <sandboxProfile>): <promptSnippet ≤240> Effect: <e>. Scheduling: <s>.
```

and `promptSnippet` is the tool's own DESCRIPTION truncated to 200 chars
(`derivePiPromptMetadata`, `harness-manifest.ts:344-354`), applied to
dynamic MCP tools as well as session tools (`resolveDynamicTool`,
`harness-manifest.ts:475-479`). So every tool's description is sent
**twice**: once in its schema, once as prose. That block is **≈ 8 655
tokens, 45% of the `system_prompt` row and 12% of the whole base**, and it
carries exactly two facts the schema does not: `effect` and
`sandboxProfile`.

A third copy exists for some tools: 19 of the 38 static-prompt sections are
tool-specific prose — Browser Tools 842, File-Backed Tables 595, Session
Self-Management 522, Diagrams 444, LLM Tool 436, Configuration
Documentation 436, Plugin Management 416, HTML Preview 412, Markdown
Preview 353, Document Tools 322, Multiple Items 276, External Sources 262,
Source Templates 257, Spreadsheet 220, PDF Preview 216, Image Preview 195,
Skills 168, Data Table 164, Automation Management 109 = **6 645 tokens**
describing tools whose schemas are already present.

### `custom_subagents` 8 622 — CONTESTED, and worth resolving before anything else

Two pieces of evidence disagree, and the disagreement is exactly one row
wide.

- **Code reading says these bytes never reach the model on Pi.**
  `runtimeAgentDefinitions` reaches four consumers in
  `packages/pi-agent-server/src/index.ts` — the `subagent` tool (1734), the
  `workflow` tool (1758), skill-fork (4214), and
  `contextAccounting.agentDefinitions` (2135-2140). The Pi SDK session
  options (2079-2082) carry `{ customTools, tools }` and no `agents` field;
  the `subagent` tool's schema declares `agent: { type: 'string' }` with no
  enum and no per-agent text
  (`packages/pi-agent-server/src/orchestrator/subagent-tool.ts:454-516`);
  the prompt is resolved at spawn time
  (`subagent-tool.ts:600-603` → `spawner.ts:466-472`). On that reading the
  row is an accounting artifact and `context-categories.ts:140-144` — which
  sums `description + systemPrompt` per agent — contradicts its own file
  header's claim that "Nothing here re-composes a part for measurement".
- **The endpoint's own count says the total INCLUDING this row is right.**
  70 042 measured by the provider against 70 823 accounted. Drop 8 622 and
  the accounting predicts 62 201, which would leave ~7 800 tokens on the
  wire that nothing accounts for.

Both cannot be true. This is the repo's standing trap — an ABSENCE claim
needs a positive control, and a typed field is not a filled field — so the
plan does not pick a side. **C1 measures the wire.** Either answer is worth
8 622 tokens of the final number: if the row is real, C4 replaces it with a
~200-token listing; if it is an accounting lie, the row goes to zero, the
`/context` overlay stops telling users to delete subagents to save tokens
they are not paying, and something else ~7 800 tokens large is on the wire
and has to be found.

### `skills` 1 048 — WE ALREADY DO THIS CORRECTLY

`buildSkillListingPart` (`packages/shared/src/agent/core/prompt-builder.ts:478`)
emits one line per skill: name + a description flattened and capped at
`SKILL_LISTING_DESCRIPTION_MAX_CHARS = 180`, under a total
`SKILL_LISTING_MAX_CHARS = 4_000` budget, with a truthful
`(N more skills not listed …)` overflow line. No bodies, no paths, no
allowed-tools. That is upstream's shape: `skills.md` — "In a regular
session, skill descriptions are loaded into context so Claude knows what's
available, but full skill content only loads when invoked."

1 048 tokens ≈ 4 192 chars, i.e. the listing is **saturated at its cap and
already dropping skills**. This is not a cut target. The one adjustment
worth making is upstream's: `skills.md` says "The budget scales at 1% of
the model's context window" — a fixed 4 000 chars is 10% of a 40 960-window
model and 0.4% of a 1M one. Recorded as C8, low priority, and it makes the
listing BIGGER on large models, not smaller.

## C.3 The contract: how Claude Code and Codex do it

Every Claude page below verified present in `scripts/claude-doc-pages.tsv`
and read as raw `.md`. Sentences quoted; no line numbers (they decay).

| mechanism | Claude Code | Codex | us |
| --- | --- | --- | --- |
| tool-schema deferral | ON by default: "Tool search is on by default, with the exceptions listed in Configure tool search." (`agent-sdk/tool-search.md`) | no doc contract on this axis; the pinned protocol carries `deferLoading?: boolean` on `DynamicToolFunctionSpec` and the shipped binary carries `tool_search`, `tool_search_always_defer_mcp_tools`, `tool_search_call`/`tool_search_output`, `direct_only_tool_namespaces` | mechanism built, **default OFF** |
| what stays upfront | "The SDK always loads core built-in tools such as Bash, Read, and Edit upfront and doesn't count them toward the threshold." — scope is "each MCP tool that isn't marked `alwaysLoad`, from any server, plus the built-in tools that load on demand" (`tool-search.md`) | `direct_only_tool_namespaces` bypasses deferral | everything, always |
| threshold denominator | "Counts the tokens in the tool definitions that tool search can defer and compares the total against the model's context window. When the total reaches 10% of the window, tool search activates." (`tool-search.md`, `auto`) | booleans, no stated default | count of candidates > 48, or `auto:N` percent |
| search result shape | "Up to five of the most relevant tools are loaded into context by default, where they stay available for subsequent turns." (`tool-search.md`) | `tool_search_call`/`tool_search_output` stream items | `mcp__tool_search` returns up to 50; `mcp__tool_load` pins by exact name |
| escape hatch | "If a server's tools should always be visible to Claude without a search step, set `alwaysLoad` to `true`… since each upfront tool consumes context that would otherwise be available for your conversation." (`mcp.md`) | inverse knob | `alwaysLoad` honoured, pinned tools excluded from the candidate set |
| subagent definitions | never in the parent: "Use them to isolate context, run multiple analyses in parallel, and apply specialized instructions **without adding to the main agent's prompt**." (`agent-sdk/subagents.md`); "Claude uses each subagent's description to decide when to delegate tasks." (`sub-agents.md`) | `description` only into spawn-tool guidance; body to a separate role file | Pi: nothing on the wire (contested); **Claude: full `prompt` handed to the SDK's `agents` option** |
| skills | "skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked" (`skills.md`); "The budget scales at 1% of the model's context window." | metadata-only `SkillMetadata`, body behind an on-demand read RPC | **we match**, with a fixed 4 000-char cap instead of a window-scaled one |
| system prompt | minimal by default: "when you don't set `systemPrompt` … the SDK uses a minimal prompt that covers tool calling but omits Claude Code's coding guidelines, response style, and project context" (`agent-sdk/modifying-system-prompts.md`) | — | 9 327-token base, always, plus 8 655 of tool-contract prose |
| cache interaction | deferral is cache-POSITIVE: "…leaves the cache intact when the matched tools are deferred, the default, **since deferred definitions were never in the cached prefix**." (`prompt-caching.md`) | `body_after_prefix` compaction scope models a carried prefix | n/a today |

Upstream's own illustrative startup budget (`context-window.md`, an
interactive simulation — illustration values, contract-grade shape):
system prompt 4 200 · auto memory 680 · environment 280 · **MCP tools
(deferred) 120** · **skill descriptions 450** · user CLAUDE.md 320 ·
project CLAUDE.md 1 800 ≈ **7 850 total**. There is **no subagent line at
all**, and the same simulation prices a spawned subagent at 80 tokens in
the parent with its own system prompt recorded as `tokens: 0,
subTokens: 900` — the positive control for that absence.

**Three consequences that shape the tasks.**

1. **Upstream turns its mechanism OFF for hosts like ours, and says so.**
   `tool-search.md`: "The SDK also disables tool search when
   `ANTHROPIC_BASE_URL` points to a non-first-party host, since most
   proxies don't forward `tool_reference` blocks." The Nessy Gateway is
   exactly such a host. That is *why* our Pi mechanism is client-side —
   two ordinary tools plus a host catalog, no `tool_reference` wire
   dependency — and it is why it works for us where the SDK's would not.
   The mechanism is right; only its default is wrong.
2. **Deferral covers built-in tools upstream, not only MCP.** Ours is
   MCP-candidates-only (`isDeferredMcpCandidate` excludes
   `mcp__session__*`, `deferred-mcp-tools.ts:56-58`), so it structurally
   cannot touch the 20 182. C5 is the gap.
3. **Our cited contract has drifted.** `tool-search-settings.ts`'s header
   quotes `auto` as "Checks the combined token count of all tool
   definitions"; the page now reads "the tool definitions that tool search
   can defer", and gained the core-built-ins exemption. "exceed 10%" is now
   "reaches 10%" — our code uses strict `>`. C9 refreshes the citations and
   decides the boundary.

## C.4 Root cause of the 20 078: it was sent EAGERLY. All of it.

The placeholder listed this as the first open question and said it was
unmeasured. **It is settleable statically, and it is settled: zero of the
20 078 rode the deferral mechanism.**

The decision function is
`resolveDeferredMcpToolLoading` (`packages/shared/src/config/tool-search-settings.ts:132-180`).
On the measured profile every input is known:

| input | value | evidence |
| --- | --- | --- |
| `mode` | `{ kind: 'default' }` | `NESSY_ENABLE_TOOL_SEARCH` is set nowhere in the repo, launcher, or CI (`grep -a`: only its own parser, tests, and the i18n suggestion string that tells the USER to set it) |
| `workspacePreference` | **`false`** | `~/.nessy-agent/config-defaults.json` on the owner's machine (mtime 2026-08-15 12:14) reads `"deferredMcpToolLoading": false`; the bundled asset `apps/electron/resources/config-defaults.json` reads the same; the fallback `storage.ts:250` reads the same |
| `hasUncachedMcpSource` | false | both live connections had cached descriptors; had it been true, deferral would have turned ON and the row would be ~200, not 20 078 |
| `candidateCount` | 43 | > the threshold of 48? **no** — even a `true` preference would have needed 49 |

`case 'default': if (!input.workspacePreference) return { enabled: false,
reason: 'preference-off' }`. Deferral was off before the count was even
consulted. **Deferred: 0. Eager: 20 078, plus their 3 313 tokens of
prompt-contract lines — 23 391 in total, none of it needed before the model
asks for it.** That is the headroom, and it is one boolean wide.

Two aggravating facts found while proving it:

- **The user cannot turn it on through the app.** `grep -a` across the
  renderer and `packages/ui` finds no settings control for
  `deferredMcpToolLoading` — only the `/context` overlay's suggestion
  string, which tells the user to set an environment variable. And
  `syncConfigDefaults()` (`storage.ts:255-282`) **overwrites**
  `~/.nessy-agent/config-defaults.json` from the bundled asset on every
  launch, so a hand edit does not survive a restart. The only working
  control today is `NESSY_ENABLE_TOOL_SEARCH` in the environment.
- **The mechanism has ZERO live proof.** `grep -a` over
  `docs/testing/cdp-live-checklist.md` finds no occurrence of `tool_search`
  or `tool_load` anywhere, and `CMP-N5` — the positive control that the
  deferred-MCP *suggestion* can render at all — is still `⬜`. Turning a
  never-live-exercised path on by default is the one way this plan could
  ship a regression bigger than the saving. C2's gate is a live case
  BEFORE the default flips.

## C.5 The three buckets

Per block: irreducible · deferrable · removable outright.

### `mcp_tools` 20 078 (+ 3 313 of prompt lines)

| bucket | tokens | reasoning |
| --- | --- | --- |
| irreducible | **0** | not one MCP tool is needed before the model asks for a capability; upstream prices this block at 120 tokens of names |
| deferrable | **23 191** | 43 of 43 tools, minus ~200 for the two discovery tool schemas that replace them |
| removable outright | 0 | every one is a capability a user installed; removing any is a regression, not a saving |

### `system_prompt` 19 351

| bucket | tokens | reasoning |
| --- | --- | --- |
| irreducible | **≈ 2 680** | identity, safety/engineering bullets, Permission Modes 687, Interaction Guidelines 344, Tool-call preambles 177, Untrusted Content 134, final-answer formatting 123, Project Context 128, Doing Engineering Tasks 117, Interaction Boundaries 113, Reviewing changes 106, Web Search 108, Tool Metadata 99, remainder |
| irreducible (stable context) | **≈ 150** | a 73-char workspace-capabilities one-liner plus the working directory |
| deferrable | **6 645** | the 19 tool-specific prose sections listed in C.2 — each belongs with its tool, arriving when the tool does. **The six preview-format sections alone (Structured Data 4 140 chars · HTML 1 654 · Markdown 1 420 · Tabs 1 104 · PDF 871 · Image 779 = 9 968 chars ≈ 2 492 tokens) already have `DOC_REFS` entries in the Configuration Documentation table pointing at on-demand docs** — the prose is a second copy of a document the model can already fetch, which makes them the safest third of C6 |
| deferrable (existing knob, no code change) | **857** | `getBrowserToolEnabled() = false` removes the 3 426-char Browser Tools section today. The section itself says the catalogue is unusable until the model reads `DOC_REFS.browserTools`, so it is prose describing a document it then tells the model to fetch |
| removable outright | **≈ 4 340** | the description half of the `Active Nessy tool contract` lines for the 70 non-MCP tools; the MCP third (3 313) is already counted under `mcp_tools` because deferral removes it from BOTH the schema list and this block (`prompt-composer.ts:20-21` filters on `deferredMcp.candidatePiNames`) |
| removable outright (residual) | **≈ 4 486** | the remainder of the 8 655 contract block once descriptions go, minus what the reduced `name (effect, sandboxProfile)` form still costs (~220) |

### `system_tools` 20 182

| bucket | tokens | reasoning |
| --- | --- | --- |
| irreducible (built-ins) | **≈ 3 640** | upstream's named core — Bash, Read, Edit — plus Write, Grep, Find, Ls, ask_user, subagent: 9 of the 18 at the measured 404 average |
| irreducible (session) | **1 276** measured | SubmitPlan, remember, SlashCommand, BashOutput, ProcessStop, ReportFindings (+ TodoWrite): the tools a turn may need before it can ask for anything |
| deferrable (session) | **11 626** measured | the other 46: config_validate, skill_validate, mermaid_validate, source_*, update_user_preferences, Task*, Goal*, transform_data, script_sandbox, render_template, call_llm, spawn_session, browser_tool, Monitor, EnterWorktree, ExitWorktree, set_session_*, get_session_info, list_sessions, list_mcp_resources, read_mcp_resource, read_skill_resource, automation_*, send_agent_message, plugin_*, PushNotification, SendUserFile, Cron*, ScheduleWakeup |
| deferrable (built-ins) | **≈ 3 640** | NotebookEdit, web_search, web_fetch, review, get_subagent_result, steer_subagent, stopTask, workflow, bash_background — upstream defers built-ins too |
| removable outright | **unknown — do not assert** | an advertised-but-unused audit is C6b; AGENTS.md lists four documented ways this repo has been wrong about "unused", and one of them permanently destroys user data if "fixed" |

### `custom_subagents` 8 622

| bucket | tokens | reasoning |
| --- | --- | --- |
| irreducible | **≈ 200** | a bounded `<available_subagents>` listing, name + 180-char description, mirroring `buildSkillListingPart` — 7 agents |
| removable outright | **≈ 8 400 OR 0** | 8 400 if C1 finds the bodies on the wire; 0 saving (but a fixed lie) if C1 finds the row is accounting-only |

### `skills` 1 048 · `messages` 603 · `unaccounted` 939

Irreducible as measured. Skills is already at upstream's shape and
saturated at its cap.

## C.6 The descent, and the floor

Each stage is one task and banks its saving independently; execution may
stop at any stage and the plan stays coherent. Column two assumes C1 finds
the subagent bodies ARE on the wire; column three assumes they are not (in
which case the true starting base was 62 201 all along and the endpoint's
70 042 has an unexplained ~7 800 that C1 must name).

| stage | task | saving | base if C1=eager | base if C1=accounting-only |
| --- | --- | --- | --- | --- |
| 0 | today | — | 70 823 | 62 201 (wire) |
| 1 | **C2** deferral default ON (MCP) | −23 191 | **47 632** | 39 010 |
| 2 | **C3** contract block stops restating descriptions | −4 340 | **43 292** | 34 670 |
| 3 | **C4** subagent roster becomes a bounded listing | −8 400 / 0 | **34 892** | 34 670 |
| 4 | **C5** deferral extended to session tools | −11 626 | **23 266** | 23 044 |
| 5 | **C6** tool-specific prose moves out of the base prompt | −6 645 | **16 621** | 16 399 |
| 6 | **C7** deferral extended to non-core built-ins | −3 640 | **12 981** | 12 759 |

**The floor, itemized.** What a working Pi session cannot go below with
every mechanism above applied:

| component | tokens |
| --- | --- |
| core built-in tool schemas (Bash, Read, Edit, Write, Grep, Find, Ls, ask_user, subagent) | 3 640 |
| core session-tool schemas | 1 276 |
| discovery tools (`mcp__tool_search`, `mcp__tool_load`) + their prompt lines | 330 |
| irreducible system prompt (identity, safety, modes, formatting) | 2 680 |
| stable context (working directory, workspace capabilities) | 150 |
| reduced tool-contract lines, ~16 resident tools | 220 |
| skills listing (already correct) | 1 048 |
| subagent listing | 200 |
| messages + unaccounted | 1 542 |
| **floor** | **≈ 11 086** |

**So: ~11 000–13 000 is the honest floor** (the range is the C.2 residual,
which C1 closes), **and 15 000 is reached at stage 5.** Two statements the
executor must not soften:

- **The floor is not reachable by trimming prose.** Every stage above is
  structural — a default flipped, a composer that stops duplicating, a
  deferral scope widened. Editing the 38 prompt sections for concision
  might buy 1 000–1 500 tokens and would cost behavior; it is not on this
  plan.
- **Below ~12 000 the wall is the core built-in tool schemas (3 640) plus
  the safety/identity prompt (2 680).** Going lower means either dropping a
  capability a turn genuinely needs before it can ask for anything, or
  rewriting Pi's built-in tool descriptions — upstream text we do not own
  and whose wording the model's behavior is tuned to. If a later plan wants
  the last mile, that is the conversation, and its price is measured in
  capability, not tokens.

## C.7 Prioritized cuts (tokens saved ÷ risk)

| rank | task | saving | risk | why that risk |
| --- | --- | --- | --- | --- |
| 1 | **C3** contract block | 4 340 | **LOW** | pure de-duplication; the two facts the schema lacks (`effect`, `sandboxProfile`) are kept |
| 2 | **C2** deferral default ON | 23 191 | **MEDIUM** | biggest single saving and one boolean, but the path has never been exercised live — the gate is a live case first, not the flip |
| 3 | **C4** subagent roster | 0–8 400 | **LOW** | measurement-led; either fixes a lying row or replaces bodies with a listing |
| 4 | **C6** tool-owned prose | 6 645 | **MEDIUM** | prose removal changes behavior; each section must arrive with its tool, and a section that arrives with nothing is a silent capability loss |
| 5 | **C5** session-tool deferral | 11 626 | **HIGH** | new deferral scope; the capability catalog, permission layer and hook layer all key off session tool names today |
| 6 | **C7** built-in deferral | 3 640 | **HIGH** | smallest saving of the structural set, largest blast radius |

## C.8 Per-runtime differences

Measured by running each projection
(`getToolDefsAsJsonSchema`, `packages/session-tools-core/src/tool-defs.ts:1447`):

| | Pi | Claude (`anthropic`) | Codex |
| --- | --- | --- | --- |
| session tools advertised | 52 → **12 902** | 37 → **9 433** | 17 (`externalStandaloneOnly`) → **4 084** |
| `Active Nessy tool contract` prompt block | **yes** (`composePiHarnessPrompt`) | no | no |
| base prompt placement | own system prefix | **`presetAppend` on top of Claude Code's `claude_code` preset** — the real system block is LARGER than ours, and `modifying-system-prompts.md` says the SDK's own default is smaller still: "the SDK uses a minimal prompt that covers tool calling but omits Claude Code's coding guidelines" | own prefix, **+4 414 chars** of Codex-only blocks (planning tools, MCP naming, source management) that no other runtime renders |
| stable context placement | folded into the cached system prefix | user-message tail | user-message tail |
| MCP deferral mechanism | built, **default off** | none — and the SDK's own is disabled for us by contract (non-first-party `ANTHROPIC_BASE_URL`) | none wired; `deferLoading` exists in the pinned protocol and appears **nowhere in our TypeScript** |
| subagent payload | spawn-time lookup (contested — C1) | **full `prompt` handed to the SDK's `agents` option** (`claude-runtime-agents.ts`), suppressed in `mini` mode | `description` only into spawn guidance; body to a separate role file |
| skills | one shared `buildSkillListingPart` — identical on all three | same | same |

**Knobs that already exist** — checked so no task re-invents one, and so
the executor knows how little is reachable without code. Verified absent
with `grep -a` across `packages/shared/src` and
`packages/pi-agent-server/src`: there is **no** concise-prompt mode, no
prompt budget, no `trimPrompt`/`minimalPrompt`, and no section-level
feature flag. The complete list of existing switches is:

| knob | effect | verdict |
| --- | --- | --- |
| `getBrowserToolEnabled() = false` | −3 426 chars (−857 tokens) | the largest config-level cut available today; costs the browser tool |
| `workspaceDefaults.deferredMcpToolLoading` / `NESSY_ENABLE_TOOL_SEARCH` | −245 chars per deferred MCP tool, on top of the schema | **C2** |
| skill overrides (hidden / name-only) | shrinks the listing | already correct |
| `keep-coding-instructions: false` | **only ~700 chars**, and **no built-in output style sets it** — all six set `keepCodingInstructions: true`, so only a custom or plugin style file can reach it | not worth a task |
| built-in `concise` output style | **ADDS ~250 chars** — it shortens replies, not the prompt | a trap; do not cite it as a diet knob |
| `preset: 'mini'` | ~900 chars instead of 37 400 | exists and is wired **only** to the EditPopover quick-edit agents, never a chat session. Whether a chat session could opt into a reduced preset is a real question and belongs to a later plan, not this one |

Consequences for scope:

- **C2/C3/C5/C6 are Pi-only** as written. Claude and Codex do not carry the
  contract block and have no deferral surface.
- **Claude carries the subagent bodies for real.** Whatever C1 concludes
  about Pi, the Claude runtime demonstrably hands full agent prompts to the
  SDK. C4 must state a per-runtime answer, not one.
- **Codex has a free mechanism we have never turned on.** The pinned
  protocol's `deferLoading` and the binary's `tool_search` /
  `tool_search_always_defer_mcp_tools` / `direct_only_tool_namespaces` are
  shipped and unused. Scoped as C10 (investigation, not a commitment).

## C.9 Verification design

**Three instruments, in increasing authority.** No conclusion rests on one.

1. **`/context` after ONE REAL TURN.** The product's own accounting. Never
   on a fresh session — it reads `system_prompt` 0 / `mcp_tools` 0 and
   understates by 60%. This instrument alone cannot distinguish "we changed
   what we send" from "we changed how we count", which is precisely the
   `custom_subagents` question.
2. **The outbound request body.** The unified network interceptor is
   already preloaded into the Pi subprocess
   (`agent/backend/internal/runtime-resolver.ts:resolveInterceptorBundlePath`)
   — capture the composed `system` string and the `tools` array and count
   the bytes actually sent. **This is the instrument that settles C1**, and
   it is the control that separates an accounting change from a request
   change. Note the packaged-build rule: `electron:dev` preloads the `.ts`
   source and a packaged build the `dist/interceptor.cjs`, returning
   `undefined` (silently unpatched) if the bundle is missing. Live evidence
   comes from a packaged build.
3. **The product's own promise.** Set the connection to a 40 960-window
   model and require that the FIRST turn now succeeds. Today it returns
   `400 … your request has 70042 input tokens`. No accounting change can
   fake this, and it is the only measure the user experiences.

**The control that distinguishes "smaller because we deferred it" from
"smaller because we broke it": a capability roll-call.** Before and after
each stage, enumerate the tools the session can REACH, not the ones it
advertises. For every tool moved out of the eager set:
`mcp__tool_search` finds it by name and by description keyword,
`mcp__tool_load` loads it, and it then EXECUTES. A tool that is neither
advertised nor loadable is a regression, and the roll-call fails with its
name. Target counts: 43 MCP tools (C2), 46 session tools (C5), 9 built-ins
(C7). A roll-call that passes with fewer names than the stage moved is a
failed roll-call, not a partial one.

**Positive control for every absence claim.** `CMP-N5` in
`docs/testing/cdp-live-checklist.md` is still `⬜` — nothing has ever shown
the deferred-MCP suggestion rendering at all. Drive it before trusting any
"the suggestion is gone now" reading. Same discipline for "the contract
block is gone": prove the block RENDERS on a control session before
asserting its absence proves anything.

**Re-measure discipline.** Every stage records: the number measured, the
artifact it was read from, and the control that ruled the alternative out.
A stage whose tracker note carries a number but no artifact is not landed.

## C.10 Tasks

Each carries a Step 0 (see § Execution protocol) and a safety gate. No
capability may disappear silently; a tool that vanishes from a session is a
regression, not a saving.

**C1 `chore(context): measure the wire, not the accounting`** —
INSTRUMENTATION ONLY, no product behavior change. Capture the composed
`system` string and the `tools` array actually sent on a Pi turn (packaged
build, interceptor). Report: total bytes; per-tool schema bytes for the 18
built-ins (the 7 280 residual in C.2 becomes a measurement); whether any
agent `description`/`systemPrompt` text appears anywhere in the payload.
**This task answers the contested `custom_subagents` row and confirms the
20 078 was fully eager.** Deliverable is numbers written into the tracker
note and into `docs/testing/cdp-live-checklist.md`, plus — if the row is an
accounting artifact — a named account of the ~7 800 tokens the endpoint
counted and we did not. Safety gate: read-only; if the instrument requires
a code change, it is a debug-only path behind an env flag, never on by
default.

**C2 `feat(context): defer MCP tool loading by default`** — flip
`workspaceDefaults.deferredMcpToolLoading` to `true` in
`packages/shared/src/config/storage.ts` FALLBACK **and** in
`apps/electron/resources/config-defaults.json` (both, or the bundled asset
overwrites the change on next launch), and give the preference a real UI
control so it is reachable without an env var. Cite `tool-search.md`'s
"Tool search is on by default" as the contract being matched, and record
the deviation that our client-side mechanism exists precisely because the
SDK disables its own for non-first-party hosts. **Safety gates, all
blocking:** (a) a live case exercising `mcp__tool_search` → `mcp__tool_load`
→ execute end-to-end on a real MCP server, added to the checklist — the
path has no live proof today; (b) the 43-tool capability roll-call; (c)
`alwaysLoad` verified to still pin a server past the default; (d)
`CMP-N5` driven so the suggestion surface is proven to render before we
change what it says; (e) the uncached-source floor
(`tool-search-settings.ts:145`) still outranks a `false` override —
regression test.

**C3 `refactor(prompt): stop restating tool descriptions in the contract block`**
— `composePiHarnessPrompt` emits `- <piName> (<effect>, <sandboxProfile>)`
and drops the `promptSnippet` + `Effect:`/`Scheduling:` repeat. Keep an
opt-in for the full form behind a debug flag if the executor judges the
prose load-bearing for a specific tool, and if so name that tool rather
than keeping the block for all. Safety gate: the two facts the schema does
not carry (`effect`, `sandboxProfile`) survive; a focused test asserts the
block still names every resident tool; a live turn confirms tool selection
behavior is unchanged on a task that uses three different tools.

**C4 `feat(context): bounded subagent roster`** — DEPENDS ON C1.
- If the bodies are on the wire (Pi and/or Claude): replace them with a
  bounded `<available_subagents>` listing mirroring `buildSkillListingPart`
  — name + 180-char description, one line each, budgeted. Contract:
  `agent-sdk/subagents.md` — "without adding to the main agent's prompt";
  `sub-agents.md` — "Claude uses each subagent's description to decide when
  to delegate tasks."
- If they are not (Pi accounting-only): fix
  `packages/pi-agent-server/src/context-categories.ts:140-144` so the row
  reports what is sent, and fix the suggestion built from the same array —
  today it can tell a user to delete subagents to save 8 622 tokens they
  are not paying.
Per-runtime answer required; the Claude path is not the Pi path. Safety
gate: a subagent still spawns by name after the change, on each runtime
that carries agents (`AGENT_DEFINITION_RUNTIMES`).

**C5 `feat(context): extend deferral to session tools`** — widen the
candidate predicate beyond `isDeferredMcpCandidate`'s
`!name.startsWith('mcp__session__')` so the 46 deferrable session tools
join the catalog. **Highest blast radius on this plan.** The permission
layer, the hook layer and the capability catalog all key off session tool
names; `validateDefinitions` throws when a manifest tool has no runtime
definition. Safety gates: the 46-tool roll-call; a permission rule written
against a deferred tool still fires when the tool is loaded; a hook bound
to a deferred tool still runs; the manifest hash changes deliberately and
its contract test is regenerated, not suppressed.

**C6 `refactor(prompt): tool-specific prose rides with its tool`** — move
the 19 tool-specific sections (6 645 tokens, enumerated in C.2) out of the
always-on base prompt and attach them to the tool they describe, arriving
when the tool does. **Start with the six preview-format sections** (9 968
chars ≈ 2 492 tokens): each already has a `DOC_REFS` entry in the
Configuration Documentation table pointing at an on-demand doc, so the
prose is a second copy of something the model can already fetch — the
safest third of this task, and the one that needs no new mechanism. Browser
Tools (3 426 chars) is the same shape: the block itself tells the model the
catalogue is unusable until it reads `DOC_REFS.browserTools`. Safety gate:
for each moved section, the behavior it governs is exercised live once with
the tool loaded — a section that arrives with nothing is a silent
capability loss, which is exactly the failure mode this plan exists to
avoid. **Sections governing SAFETY or IRREVERSIBLE actions do not move**,
regardless of which tool they mention; and nothing moves from the system
prefix into a VOLATILE part, because the prefix is deliberately identical
across permission modes so a mode switch does not invalidate Pi's cache.

**C6b `chore(context): advertised-but-unused audit`** — READ-ONLY, produces
findings, not edits. Which advertised tools does a session never call? Before
filing anything, read the nine dated owner decisions indexed in
`docs/superpowers/specs/2026-07-29-inert-worklist.md` §3 and the four
"unused identifier" shapes in AGENTS.md. A finding here becomes a row in a
LATER plan, never a deletion in this one.

**C7 `feat(context): defer non-core built-in tools`** — the last stage.
Contract: `tool-search.md` — "The SDK always loads core built-in tools such
as Bash, Read, and Edit upfront and doesn't count them toward the
threshold", scope "plus the built-in tools that load on demand". Candidates:
NotebookEdit, web_search, web_fetch, review, get_subagent_result,
steer_subagent, stopTask, workflow, bash_background. Safety gate: the
9-tool roll-call; `disableWorkflows` / `NESSY_DISABLE_BACKGROUND_TASKS`
still remove their tools from the SIGNED manifest rather than merely
deferring them — an off switch and a deferral are different states and must
stay different.

**C8 `feat(context): scale the skill-listing budget with the window`** —
`SKILL_LISTING_MAX_CHARS` becomes window-relative, per `skills.md`'s "The
budget scales at 1% of the model's context window". Low priority, and note
that on large models this makes the listing BIGGER. It is on this plan
because the listing is currently saturated and silently dropping skills.
Safety gate: the overflow line stays truthful at every window size; a
40 960-window model does not lose the listing entirely.

**C9 `docs(context): refresh the tool-search contract citations`** — the
header of `packages/shared/src/config/tool-search-settings.ts` quotes a
superseded sentence and cites decayed line numbers. Re-quote from the raw
`.md`, sentence not line number. Decide explicitly whether `>` should
become `>=` ("reaches 10%") and whether the denominator narrows to
deferrable definitions only — both are behavior changes, so decide them
deliberately with a test each, or record why they stay.

**C10 `spike(codex): does the binary already defer?`** — READ-ONLY.
`deferLoading` on `DynamicToolFunctionSpec` in the pinned protocol, plus
`tool_search`, `tool_search_always_defer_mcp_tools`,
`direct_only_tool_namespaces` in the shipped binary's config schema, and
**zero occurrences of `deferLoading` in our TypeScript**. Report whether
turning these on is a config write we already own. Produces a finding and,
if positive, a row in a later plan.

**C11 `chore(scripts): restore the IPC channel inventory generator`** —
carried over intact from the placeholder, and unchanged in substance. The
frozen RPC inventory `apps/electron/src/shared/__tests__/ipc-channels.test.ts:13`
says «Auto-generated by scripts/ipc-inventory.ts — DO NOT edit by hand» and
**that script does not exist** (verified a third time this session:
`ls scripts/ipc-inventory.ts` → No such file). That is how three
feat/models-fetch channels drifted in silence until a release-gate
`bun test` caught them, fixed by hand in `e16df6563`. Add the generator the
comment promises (the working flatten-from-`RPC_CHANNELS` logic is recorded
in the spawn-task chip text and in `e16df6563`'s repair), give it a
`--check` mode wired into `bun run validate:ci` so drift becomes a named
failure, and **leave the two sibling registration contracts alone** — they
catch a different drift class (registered-but-undeclared) and must stay as
they are. Scheduled at this plan's tail to avoid racing lane C's regression
wave on `validate:ci` and the same test file. Independent of every other
task here.

## C.11 Related, not folded in

The F1 usability-window row — mark a model whose context window is below
the resting base as unusable-on-profile — stays in lane F of
`2026-08-14-runtime-icons-plates-model-sync.md`. It consumes this plan's
number; it does not produce it. When lane C lands a new resting base, F1's
threshold changes with it, and whoever closes lane C tells lane F the
number.

---

# LANE K — Credential store: machine-id resilience + v1 cleanup

**This lane is a STUB written from a live incident, not a verified plan.**
It is carried over from `2026-08-15-credential-store-machine-id.md`
essentially verbatim, and its file:line coordinates are from that draft and
have NOT been re-verified in this session. Step 0 applies with full force:
re-verify every coordinate and every claim before touching code, and correct
the task text in the landing commit.

## K.1 The defect, measured live 2026-08-15

`getStableMachineId()`
(`packages/shared/src/credentials/backends/secure-storage.ts:92-126`,
UNVERIFIED coordinate) derives the encryption key's machine identity as
macOS `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID`, and on ANY
failure **silently falls back** to `` `${userInfo().username}:${homedir()}` ``.
Two sources → two different keys → a store written under one reports
«Credential store is corrupt … decryption failed with all known keys» under
the other. Hit live twice during the F5 sittings: a `PATH` without
`/usr/sbin` made `ioreg` unresolvable, and the owner's real store on this
machine is written under the FALLBACK key — so a packaged build, where
`loadShellEnv()` always resolves `ioreg`, reports "corrupt" on this profile.

**Data is safe by construction.** The live backend is v2-only
(`initializeCredentialManagerV2` is the sole singleton path;
`getCredentialManager()` throws without it) and v2 FAILS CLOSED
(`CredentialStoreCorruptError`, file left untouched, no delete path). The
v1 backend's delete-on-corrupt (`handleCorruptedFile`) is unreachable in
production — verified in the source draft by enumerating every
`new CredentialManager(` site; re-verify at Step 0.

**Scenarios that hit this without our rig:** a new Mac or Migration
Assistant (different `IOPlatformUUID`), a logic-board replacement, some
VM/MDM images, and the worst one — a single `ioreg` failure at the moment of
the FIRST write permanently poisons the install, because every later normal
launch then reads "corrupt". In all cases the message misdiagnoses
(«corrupt» instead of «keyed to another machine») and the UI offers no
recovery except re-entering every key.

## K.2 Tasks

**M1 `fix(credentials): key mismatch migrates instead of erroring`** — on a
failed decrypt with the stable key, TRY THE FALLBACK-DERIVED key (and vice
versa — the store may be under either), and on success RE-ENCRYPT under the
current stable key. This is the exact pattern the file already uses for the
legacy hostname-v1 key (`deriveLegacyKeyV2`, migration-on-read), so the
change is a second instance of a shape already in the file, not a new
mechanism. Only when BOTH derivations fail is the store genuinely
undecryptable, and the message then says honestly which case it is:
«encrypted under a different machine identity» (both failed, file
structurally valid) vs real corruption (bad magic/format). Never delete,
never overwrite on failure — v2's fail-closed contract is untouched.
Tests: a store written under the fallback key opens and migrates under the
stable key (the live incident, red-then-green); the reverse direction; both
fail yields the honest message; a structurally broken file still says
corrupt.

**M2 `chore(credentials): quarantine the v1 backend`** — the v1
`SecureStorageBackend` (delete-on-corrupt, `handleCorruptedFile`) is latent
dead weight: production constructs v2 only. **BEFORE removing**, check the
inert-worklist AND the pre-W10 compatibility need — `manager.ts`'s header
comments name a "pre-W10 runtime adapter" that reads the v1 FORMAT, and the
format reader may need to survive even if the backend class dies; the
storage-v2 plan (W7-W10, July) is the decision record. Either remove v1
plus the unreachable `ensureInitializedSync`/`_doInitialize` init branch
(with their casts at `manager.ts:130/:138/:143`, UNVERIFIED coordinates),
or record with a dated note why the format reader stays. A deny-path that
DELETES user credentials must not survive as reachable-by-refactor code.
This is precisely the shape AGENTS.md warns about — "enforcement one layer
up" and "identically-named symbols in a sibling subsystem" — so the finding
must name the subsystem and verify the consequence separately from the
identifier.

## K.3 Gates

Focused credentials suites + `typecheck:shared`; M1's migration tests;
`git diff --check`. Credential handling is an immediate risk trigger under
the Implementation-First Verification Budget (auth/permission decisions), so
run the smallest expanded set that proves the boundary once on the final
diff.

---

# Execution protocol (repo standing rules, restated because they bind here)

**Step 0 — per-task re-verification, before starting each task.** Every
coordinate, count and claim in a task's text was measured at authoring time
and decays. Before writing code for task X: re-verify X's file paths, line
numbers, counts and quoted contract sentences against HEAD, and **correct
the task text in the same commit that lands the task**. Lane K's
coordinates are known-unverified and must all be re-derived.

**Rule 8 — stop if a correction changes the APPROACH.** A drifted line
number, a renamed symbol or a recount is a correction: fix it and continue.
A finding that changes what the task should DO — the mechanism is not where
the plan said, the saving is not there, the safety gate cannot hold — is a
STOP. Report and wait; do not improvise a different task under the same
row.

**Tracker note contract.** Every row's note carries three things:
1. **the number MEASURED** — the actual figure, not "reduced" or "improved";
2. **the artifact it was read from** — `/context` overlay after a turn, the
   intercepted request body, `~/.nessy-agent/mcp/tool-descriptors/<hash>.json`,
   a named test's output, the endpoint's own refusal;
3. **the CONTROL that ruled the alternative out** — what distinguishes this
   result from the plausible wrong reading. For lane C the standing
   alternative is "smaller because we broke it", and the control is the
   capability roll-call by name and count.

A row whose note has a number but no artifact is not landed. A row whose
note has an artifact but no control is landed and unproven; say so in the
note rather than upgrading it.

**Repo traps that bite this plan specifically.**
- `grep -a` for every ABSENCE claim — several files here carry a NUL byte
  and plain `grep`/`rg` skips them silently. Every absence asserted above
  was taken with `-a`.
- `rm -rf release` before any `bun test` wave: a packaged build leaves 182
  renderer sources under `release/**/Resources/app/src/` that the root run
  collects.
- Never `git commit -a`, and never `git commit <pathspec>` while another
  session may be mid-edit in the same file — it takes the working-tree
  state, not your hunks. Zone by FILE.
- Live evidence comes from a PACKAGED build. `electron:dev` runs the host
  and the Pi subprocess from built bundles, and the interceptor preloads
  from `.ts` in dev but from `dist/interceptor.cjs` when packaged, returning
  `undefined` — silently unpatched — if that bundle is missing.
- Do not size a test knob against zero. A session's base context is the
  floor; a threshold set below it compacts forever and reads like a broken
  feature.

# Close-out (ONE, covering both lanes)

Per AGENTS.md, when the last row lands:

1. Bump the version in BOTH root `package.json` and
   `apps/electron/package.json` in lockstep. Current is **1.26.1**; this
   plan is structural on the context path plus a credentials fix, so
   **1.27.0** unless the executed subset is materially smaller.
2. Add a NEW `apps/electron/resources/release-notes/<version>.md` — never
   edit or delete an existing one. Match the in-app style (`# Nessy Desktop
   <version>`, date line, `## NEW` / `## IMPROVED` / `## FIXED`). It carries
   sections for both lanes: the resting-base reduction with its measured
   before/after number, and the credential-store recovery.
3. Update the affected `docs-site/` pages.
4. Update `docs/testing/cdp-live-checklist.md` with the new resting-base
   table and the new live cases (deferral end-to-end, the capability
   roll-call, `CMP-N5`).
5. Regenerate the two generated specs:
   `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md`
   and
   `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`.
6. **Do NOT delete this plan.** It is where these deviations' reasons live.

# Tracker

| Task | Lane | Status | Commit | Note |
| --- | --- | --- | --- | --- |
| C1 measure the wire, not the accounting | C | ✅ | `5b3c2dda3` | **The contested row is an ACCOUNTING ARTIFACT. Agent text does not reach the model on Pi.** Measured on the wire, packaged build, real gateway: **0 of 7 agent description markers and 0 of 7 agent BODY markers** appear anywhere in the request — not in the tools array, not in the system message, not in the body at all. The code-reading side of the contested pair is right and `context-categories.ts:140-144` sums text that is never sent. **C4's first branch is void; its second branch — fix the accounting and the suggestion built from it — is the one to build.** **The measurement needed a fixture before it could mean anything, and Step 0 caught that:** the FIXTURE config dir had no agents, so measuring in it without seeding would have found no agent text and "confirmed" the verdict while proving only that there was nothing to find. **Correction, 2026-08-15, and the error is instructive:** this row first said *"this machine has no agents at all"* and *"the `claude-security` plugin that produced the original 8 622 is gone"*. **Both are false.** `claude-security@0.10.0` is installed and ACTIVE, shipping exactly the seven agent files that produced the 8 622 (`explore`, `patch-generator`, `patch-verifier`, `scan-verifier`, `scan-researcher`, `scan-inventory`, `claude-security`), with `figma@2.0.13` shipping four more. The false absence came from `find … -maxdepth 4 -type d -name agents`: the plugin cache nests deeper than four levels, so a depth-limited search reported an absence and the row asserted it as a fact about the machine. **A bounded search proves nothing outside its bound** — the same shape as the NUL-byte `grep` trap this repo already catalogues, arrived at from a different direction. Measuring first and finding no agent text would have "confirmed" the artifact verdict while proving only that there was nothing to find — an absence with no positive control, the exact trap this repo keeps paying for. Seven agents with unique per-agent markers were seeded into the fixture config first. **Numbers, read from the captured request rather than derived:** total body **137 302 bytes**; **71 tools** carrying **88 057 chars ≈ 22 014 tokens** of schema; the system prompt rides as `messages[0]` on this OpenAI-shaped wire (`body.system` is absent, so a reader looking there measures 0) at **46 446 chars ≈ 11 612 tokens**. Largest schemas: `mcp__session__Goal` 818 tok, `spawn_session` 726, `call_llm` 670, `browser_tool` 658, `transform_data` 600. **What this row could NOT close, stated rather than fudged:** the ~7 800-token reconciliation between the endpoint's 70 042 and the accounted 70 823. The original stated reason — "the profile no longer exists" — was wrong (see the correction above); the profile is here. **The re-measure was attempted and did not run.** The real config dir was COPIED to a scratch path first, deliberately excluding `credentials.enc`: M1 now migrates a fallback-keyed store by RE-ENCRYPTING it, so pointing a packaged build at the owner's real config would have rewritten their credential store as a side effect of a measurement, which is not a thing a measurement may do. The copy (26 MB, plugins and agents intact, three `agents/` directories present) started the app but **produced no CDP page target** — the process stays alive and never opens a window; `activeSessionId` and `activeWorkspaceId` are both null in the copied config while five `workspaceRefs` remain, so the likely cause is the excluded `sessions/` tree. Not chased further: the reconciliation is a nice-to-have and the verdict above does not depend on it. **Still open, now with a reproducible next step rather than an impossibility.** **Instrument:** `NESSY_WIRE_CAPTURE=<path>` in the Pi interceptor — debug-only, no default path, one JSON line per request, failures swallowed so a diagnostic can never break a turn. **Trap found while using it:** the flag must be EXPORTED, not passed as a command prefix — `ps eww` confirmed the prefixed form reached neither the main process nor the Pi subprocess while `NESSY_CONFIG_DIR` did. The interceptor preload was verified present in the subprocess command line first, since a missing bundle starts Pi unpatched with no error. |
| C2 defer MCP tool loading by default | C | ✅ | `aa47bdbb5` | **DONE, and the flip alone would NOT have delivered it — that is the finding.** Measured before changing anything, on the profile C.4 recorded (mode `default`, 43 deferrable tools, threshold 48): `resolveDeferredMcpToolLoading` returned `preference-under-count`, **deferral OFF**. It needed 49 tools to fire and the machine that measured 20 078 tokens of eager MCP definitions had 43. So the two config sites would have read `true`, every test would have passed, and not one token would have moved — the row's own stated failure mode wearing a different disguise. **The count was wrong, not merely unlucky:** `tool-search-settings.ts`'s own first contract point says the `(unset)` row consults no count and no percentage (the 10% belongs to the opt-in `auto` row). While the preference shipped OFF that threshold was unreachable and harmless; the moment it ships ON it becomes the whole behaviour. The `default` arm now consults the preference alone, with the same empty-catalogue guard the `always` arm already carried. `PI_DEFERRED_MCP_TOOL_THRESHOLD` survives with one job — `auto` on a model whose window we do not know — and its comment says so. **Gate (b), both halves.** Static: both sites flipped, pinned by `deferred-mcp-tool-loading-default.test.ts`, which fails if either drifts. Live: the packaged bundle carries `"deferredMcpToolLoading": true` at `Nessy Desktop.app/Contents/Resources/app/dist/resources/config-defaults.json`, and the restart MECHANISM was driven against that packaged asset in two separate processes — a planted pre-flip profile (`false` on disk, the exact value C.4 measured on the owner's machine) came back `true` on disk and `true` as read, both times. **With a negative control:** the same code pointed at a pre-flip asset root leaves `false`, so the `true` comes from the shipped file and not from a code path that defaults to true. `ensureConfigDefaults()` is wired into `ensureConfigDir()`, which both hosts call at bootstrap (`headless-start.ts:483`, `main/index.ts:337`). **Honest gap, and it is the GUI and not the mechanism:** the unsigned local build exits immediately in this environment, so the app was never driven through its own startup. `open(1)` does not forward `NESSY_CONFIG_DIR`, and the instance it launched never reached the sync (the real profile's mtime is unchanged at 2026-08-15 12:14, still `false` — the owner's config was NOT modified by this work). Reproducible next step for anyone who wants the last mile: a signed build, or `electron` with the env inherited. **Gate (d) — BLOCKING under the no-toggle default, and it holds.** Pinning every tool of a server turns the discovery surface off entirely rather than merely shrinking the candidate list, all six stay registered, and the negative control (same tools unpinned) defers — so the assertion cannot pass while deferral is broken outright. **Gate (e) holds**: the uncached-source floor still outranks an explicit `false`. Both are red-if-broken tests, not inspections. **Gate (a), the roll-call**, is by NAME and not by count: 43 tools deferred, 43 still registered, `mcp__tool_search` and `mcp__tool_load` present — deferral moves definitions out of the upfront payload without dropping a capability. **Upgrade path, checked because it would have stranded every existing user:** both read sites go through `loadConfigDefaults().workspaceDefaults`, there is no per-workspace persisted copy, and the same overwrite that once made a hand-edit unable to survive a restart now carries the flip to every existing install on first launch. **One thing deliberately NOT changed:** the `/context` suggestion still tells the user to set `NESSY_ENABLE_TOOL_SEARCH=true`. It fires on token cost alone, so under the new default it only appears when deferral is genuinely off — where the advice is still correct. Evidence: 42/42 on the four gate suites, 1 758/1 758 across the affected areas. The superseded park note is kept below the table under **C2's original park note**. |
| C3 contract block stops restating descriptions | C | ✅ | `a5d0f38b4` | **Step 0 verified the premise and found a second repeat the row does not name.** `promptSnippet` IS the tool's `description` truncated to 200 chars (`harness-manifest.ts` `derivePiPromptMetadata`), so the model was handed every description twice in one request — the schema and the contract block. **And `Effect: …` repeated the `effect` already in that same line's parenthetical**, a duplicate inside a single line. **Correction to the row, coordinates not approach:** it says keep `effect` + `sandboxProfile` and drop the `Effect:`/`Scheduling:` repeat — but `scheduling` appears NOWHERE else, so following the wording literally would have silently lost it. It moves into the parenthetical instead. The line is now `- <piName> (<effect>, <sandboxProfile>, <scheduling>)`. **The debug opt-in the row offers was deliberately not built:** it exists for prose an executor judges load-bearing, and this prose is the schema's own description — an opt-in to re-send a duplicate is a switch nobody can correctly decide to use. **A robustness defect the change surfaced and fixed:** a descriptor missing a field used to be harmless because the value was interpolated into prose; in a bare parenthetical it renders the literal string `undefined` INTO THE MODEL'S PROMPT. Fields are now filtered before joining, and the test asserts the prompt contains no `undefined`. **Measured, not estimated:** 38 session-registry tools carry descriptions; net **8 950 characters / ≈2 238 tokens** removed (9 520 out, 570 back for `scheduling`). That is a FLOOR over the session registry — the row's 4 340 spans the full manifest, which also carries MCP and plugin tools with typically longer descriptions, so the two figures are not in conflict and neither is a re-derivation of the other. Evidence: `bun test .../pi-harness/prompt-composer.test.ts` → **3 pass / 0 fail**; `bun test .../pi-harness/` → **530 pass / 0 fail**; `bunx tsc -p packages/shared/tsconfig.json` exit 0. **Control — disabled-source revert:** dropping `scheduling` from the fact list turns exactly one row red (2 pass / 1 fail), restored to 3/0, so the fact is asserted rather than incidentally present. **Safety gate met:** the block still names every resident tool (the four plugin-management rows assert it by name). |
| C4 bounded subagent roster | C | ✅ | `a74d26995` | **Rescoped to ONE branch by C1's measurement.** The row's first branch — replace the bodies with a bounded listing — is void: there are no bodies on the wire to bound. Only the accounting fix was built. **A correction to the row's own premise:** it says the suggestion "can tell a user to delete subagents to save 8 622 tokens they are not paying". There is no such suggestion — the builder emits exactly three ids (`defer_mcp_tools`, `trim_memory_files`, `gate_skill_listing`) and subagents is not among them. What lied was the **category row itself**, which is worse in one way and better in another: it appeared in the breakdown of where the window goes, as the second-largest line, naming a place the window does not go. The row now reports **0 tokens** and keeps the agent NAMES, so the roster stays visible and its absence is not read as a bug; only the cost claim is corrected. Pi-scoped by construction — this file is the Pi accounting path, and the Claude runtime ships agent bodies to its SDK, so its answer is its own and is untouched here. Evidence: `bun test .../context-usage.categories.test.ts .../context-usage-real-server.test.ts` → **7 pass / 0 fail**; `bunx tsc -p packages/pi-agent-server/tsconfig.typecheck.json` exit 0. **Control — disabled-source revert:** restoring the `estimateTokens(description + systemPrompt)` sum turns **4 of 5** rows red (1 pass / 4 fail), restored to 5/0 — so the zero is asserted across the suite rather than incidentally true. The blanket "every category > 0" loop now carves out this one row explicitly, with the measurement quoted at the carve-out so a later reader does not restore the sum to make the loop uniform again. |
| C5 extend deferral to session tools | C | ✅ | | **CLOSED 2026-08-16 by the orchestrator. The row was RIGHT and my first re-reading of it was WRONG — recorded because the error is the reusable part.** I claimed session tools resolve as `resolvedCapability` and were therefore already candidates, on the strength of `PI_TOOL_BINDINGS` having 22 entries with no `mcp__session__*` among them. It has **77**, of which **55** are session bindings; my count came from a regex over one block of the file and missed the rest. A bounded search proving nothing outside its bound, for the third time on this plan. So session tools ARE known bindings, DO resolve as `piBuiltin`, and the `resolvedCapability` branch never saw them — exactly as the row said. **What the row got right and what it over-estimated:** the exclusion is by source kind, as written; but closing it does NOT require moving between source kinds, which is where the permission/hook/catalogue blast radius lived. C7's allowlist shape solves it with a second filter branch and no kind change. **Written as a KEEP-list, not a defer-list, and that is the load-bearing design choice:** there are 55 session bindings and the set grows, so a defer-list would silently leave every NEW tool loaded while a keep-list leaves every new tool deferred — the safer default now that deferral ships on. Ten stay upfront (`SubmitPlan`, `TodoWrite`, the five Task tools, `Goal`, `GoalGet`, `remember`) under a rule that can be argued with rather than guessed at: a session tool stays upfront when the TURN'S OWN CONTROL FLOW needs it; everything else is reached because the user asked for that thing specifically, which is what `mcp__tool_search` serves. Mirrors `agent-sdk/tool-search.md` applied to the session surface — core means "used without being asked", not "important". **Deferring is not removing:** a deferred tool stays in the signed manifest, findable and callable, so a wrong keep-list entry costs one round-trip rather than a capability. **Evidence:** `harness-manifest.test.ts` 28 pass / 0 fail with a new case asserting both directions — the deferred ones are candidates AND still in the manifest, the kept ones are neither — plus negative controls that `read` and `ask_user` never enter the candidate set. `pi-harness` + `pi-agent-server` together 1 234 pass / 0 fail. Full repository run recorded below rather than the affected areas alone, because a default's blast radius is every test that wrote the old default down as an assumption. \| **Parked behind C2, same shape and same reason as C7 — established by Step 0, not assumed from it.** The row describes itself as widening a predicate past `isDeferredMcpCandidate`'s `!name.startsWith('mcp__session__')`. That is not where the exclusion lives. Session tools are built by `staticTools(orchestrator)` from `PI_TOOL_BINDINGS` and carry `source: { kind: 'piBuiltin' }` (`harness-manifest.ts:323-331`), while the candidate filter admits only `tool.source.kind === 'resolvedCapability'` (`:600-602`). **So the 46 session tools are excluded structurally, by their source kind, not by a name prefix** — and C5 is a move between source kinds rather than a predicate change, which is precisely the blast radius the row already warns about (permission layer, hook layer, capability catalog, manifest hash, `validateDefinitions`). **And the saving is conditional on C2**, exactly as C7's is: deferral is `false` in both config sources, so tools moved into the candidate set are not deferred in the default configuration and save nothing. Taking C5 now would mean the highest blast radius on the plan in exchange for zero default-configuration benefit. The row's safety gates stay right for whenever it is built: the 46-tool roll-call, a permission rule written against a deferred tool still firing once the tool loads, a hook bound to a deferred tool still running, and the manifest hash changing **deliberately** with its contract test regenerated rather than suppressed. |
| C6 tool-specific prose rides with its tool | C | ✅ | `f0bfa4972` + `3b2035b38` | **Closed at the sections that had a real destination; the rest is itemized below rather than forced.** Two moves, both live-gated on a packaged build. **(1) Five preview-format sections → their doc.** Step 0 correction: **five, not the six the row names** — `Multiple Items (Tabs)` has no `DOC_REFS` key, so removing its 1 143 chars would be a capability loss with nowhere to fetch from. Measured **5 517 chars ≈ 1 379 tokens** removed; the row's estimate for the group (9 968) is high — the six together measure 7 676. Gate: all five produced their artifact and **none needed to read the doc first**, so the prose was redundant rather than load-bearing. **(2) Browser Tools catalogue → `--help` and the guide.** 2 360 chars ≈ 590 tokens. This one is redundant TWICE: the block's own first rule is that every browser call is **blocked until the guide is read**, so the catalogue could never be acted on from the prefix, and `browser_tool --help` carries the same list current from the binary. Gate, and it is the stronger of the two: the model **read the guide first** (`Read` → `browser_tool` → `browser_tool`) and answered correctly — the doc-read fallback is now observed working, which the preview gate could only assume. **Total: 7 877 chars ≈ 1 969 tokens** off the always-on prefix, against the row's 6 645-token estimate for all 19 sections. **NOT moved, itemized with the reason — every one is a judgement call without a ready target, and forcing them is how safety prose ends up somewhere nobody reads it:** `Debug Mode` (6 533) and `Working Effectively` (6 351) are the two largest and neither has a doc; `Available Tools` (4 203) is the tool index itself; `Subagent Safety Core` (2 797) is fenced by the row — safety prose does not move regardless of which tool it names; `Session Self-Management` (2 146), `Plugin Management` (1 717), `MCP Tool Naming` (1 327), `Document Tools` (1 310), `Interaction Guidelines` (1 385), `Multiple Items (Tabs)` (1 143), `Source Templates` (1 043), `Developer Feedback` (763) — no `DOC_REFS` target between them. `Structured Data` (4 231), `Source Management Tools` (1 919) and `LLM Tool` (1 775) DO have docs and are the next candidates, but each mixes catalogue with judgement guidance, so each needs the attach-to-tool mechanism rather than a deletion. **The fence held: nothing left the stable prefix for a volatile part, and no safety or irreversible-action text was touched.** |
| C6b advertised-but-unused audit | C | ✅ | `3eb210f37` | READ-ONLY, as required, and the row's own instruction turned out to be the answer. **The audit already exists and is current** — `2026-07-29-inert-worklist.md` carries it, and its §3 holds the nine dated owner decisions the row warns about. I read all nine before filing anything, and the warning is accurate: decision **2** is the model-allowlist one, where filtering at the persistence boundary "would round-trip through `updateLlmConnection` — which rebuilds connections from a hardcoded allowlist — and **permanently destroy a user's model list**". An obvious-looking fix there is destructive. **Nothing new filed, deliberately.** §4 already records three false positives the sweep produced (`macosSeatbeltBashSandboxEnabled` — only its SETTER is unused; `MANAGED_DELIVERY_SOURCE` — read as a default parameter; `SendUserFile`'s text — fixed in `a98b656e`), plus the four shapes the sweep keeps missing: getter/setter pairs, default-parameter reads, enforcement one layer up, and identically-named symbols in a sibling subsystem. A fresh sweep that does not clear those four reproduces the same false positives, and this lane has no budget to do it properly. **One thing this lane DID add to the same subject, from C1:** `context-categories.ts` summed `description + systemPrompt` per agent for a row whose bytes never reach the model — an advertised cost that was not paid. That is exactly a C6b-class finding, it was found by measurement rather than by grep, and it is already fixed (C4, `a74d26995`). Recording the overlap so the next sweep does not re-file it. |
| C7 defer non-core built-in tools | C | ✅ | `2cb8502b2` (test conversion) |**THE TEST REWRITE IS UNDER WAY AND ITS DESIGN IS SETTLED — that was the hard part and it is landed.** `2cb8502b2` converts `pi-runtime-cwd-transaction` from counting sessions to identifying them. **The discriminator is the REGISTRY, measured rather than assumed:** a transaction session is built on a registry created for it, a rebuild RE-USES the registry of the session it replaces — twelve sessions pair with twelve `registry_create`s in the passing control, while a run carrying one tool load shows the rebuild re-using registry 1. `transactionSessions()` selects on that and is blind to how many times the tool list changed. The twelve-row sequence table is CONVERTED rather than dropped: same twelve sessions, same order, same directories, same strategies — only the identification moved. **Two sites are deliberately stripped of their id rather than resolved through the helper**, because resolving them would be WRONG and not merely redundant: both assert a model change applied its compaction override, which happens on whichever session is active, and after a rebuild that is not a transaction session at all. One already carried a comment calling the number incidental while still asserting it. **Progress under the renumbering load, which is the only honest measure of this rewrite** (a conversion that passes only without the load has not been tested against its own subject): the run went from an immediate 122-second timeout at the FIRST ordinal to reaching PREPARE — which **succeeds** — then COMMIT, and now fails much later at `committed-token search`. **Remaining, so it is not rediscovered:** the sites past the commit phase still name sessions positionally; they are the same class and the same helper resolves the transaction-scoped ones, while the active-session ones want their id dropped. The rule for telling them apart is the one already applied — ask whether the claim is about a transaction session or about whichever session happens to be active. **THE TEST CONVERSION IS COMPLETE AND VERIFIED AGAINST ITS OWN SUBJECT — `5c32d0e7f`, green WITH the renumbering load and without it.** Four further classes surfaced past the commit phase, each needing the rule rather than a substitution: the server's own `h1c-session-N` serial (asserted three times — it advances once per session, so an exact value encodes a count one layer up; those sites now assert that a FRESH session became ready, by shape and by not-seen-before), `promptSessionId` ordinals inside a composite assertion (transaction sessions, resolved through the registry helper), a raw `session_create` count that also counted rebuilds, and — the last one, and the one that mattered — **the stub's `dispose()` branch keyed on `id === 3`**, the late-candidate-load probe, which fires during teardown of the failed-COMMIT candidate and is now identified by its DIRECTORY. That single ordinal was why `late_candidate_load` was never recorded once the numbering shifted. **CLOSED 2026-08-16 by the orchestrator after the executor's context ran out.** The three wiring pieces were re-applied onto the CONVERTED test and the last blocker turned out to be one more site of the very class the conversion was about: `session_id_update` was asserted by COUNT, and with deferral on, the model change during PREPARE triggers a tools-changed rebuild whose new ACTIVE session legitimately announces itself — expected 2, received 3. Counting conflated two claims. "PREPARE is private" means the host is never told the CANDIDATE is the session, not that no update is emitted at all; stated directly against `'h1c-session-' + candidateSessionId`, it is blind to how many rebuilds happened. Evidence: the cwd transaction test 1 pass / 0 fail with 60 assertions, C7's own surface 39/39, and the whole `packages/pi-agent-server/src` 700 pass / 0 fail. **WHAT REMAINED, now done:** **WHAT REMAINS FOR C7, and it is small and specific:** the cwd test needs three pieces of wiring to reach a DEFERRED built-in — the permission responder from `pi-permission-receipt-fixture.ts` in the harness message loop, a per-session map of what the extension registered, and a load-then-take-the-registered-definition fallback in the `workflow` and `web_search` probes. All three were written and worked earlier in this plan (they are in `9a4b7d281` and on `wip/c7-defer-builtins`); re-applied onto the CONVERTED test they still leave the untrusted-workflow probe timing out, and that last step was not diagnosed before context ran out. **It is one iteration, not a design question** — the conversion beneath it is done and proven. Was: green without the load only. Was: **PARKED 2026-08-16 by owner decision** — `017aebcdc` on `wip/c7-defer-builtins` still holds the implementation \| **PARKED 2026-08-16 by owner decision, on the measurement below rather than on a guess — the branch `wip/c7-defer-builtins` holds the implementation and is NOT pushed.** **CORRECTION, and it is the load-bearing one: all three findings are LATENT, not live, and an earlier note here called them "live-path defects in machinery C2 switched on by default". That was an overstatement.** Measured: for every dynamic tool `piName === bindingName`, so the deferral surface's cross-space matching is correct on the shipped path today; and the one route to a divergent piName — `resolveDynamicTool` reusing a KNOWN binding when the bindingName matches one — is closed by the manifest itself, which refuses the duplicate piName (`Pi execution manifest duplicate piName: notebook_edit`). The equality is therefore STRUCTURAL rather than merely observed. So (i) the name-space conflation and (iii) the controller keying are latent until built-ins defer, and (ii) the lost execution port is a defect in C7's OWN new code that does not exist without it — it could not be extracted at all. **What was extracted instead is better than inert plumbing:** rather than committing a `semanticIdForDefinition` parameter nobody passes, `4162b06cc` pins the INVARIANT the shipped surface silently depends on, with both halves of the structural argument as tests, so a change that makes the two spellings diverge fails next to the reason. **Release notes must therefore say "hardening ahead of built-in deferral", never "fixes a live defect".** IN PROGRESS, uncommitted, and the measurements are recorded here because they are the expensive part.** **Step 0 answered the inertness question the opposite way from C2, and it took TWO gates rather than one — either alone would have made the change a green no-op.** (1) `deferredCandidates` is `dynamic.filter(source.kind === 'resolvedCapability')` while all nine arrive through `staticTools`, so they are excluded structurally. (2) The RUNTIME gate, which the row does not mention at all: `buildDeferredMcpToolSurface` sees only `proxyTools` and filters with `isDeferredMcpCandidate`, which requires an `mcp__` prefix — measured `false` for all nine. Handing the nine directly to the surface AND listing them in `candidatePiNames` returned `enabled: true` with `hiddenToolNames: []`. **Implemented across both layers.** Candidates are derived from the ALREADY-FILTERED static list, which makes the row's safety fence structural rather than a remembered rule: `disableWorkflows` / `NESSY_DISABLE_BACKGROUND_TASKS` remove their tool before the candidate set is drawn, so a removed tool cannot become a deferral candidate. Contract: `agent-sdk/tool-search.md` — "The SDK always loads core built-in tools such as Bash, Read, and Edit upfront and doesn't count them toward the threshold", with the threshold's denominator "each MCP tool that isn't marked `alwaysLoad`, from any server, plus the built-in tools that load on demand", so the nine now count toward it and C9's narrow denominator finally matches the whole sentence rather than its first half. **THREE defects found by ONE real-server test (`pi-runtime-cwd-transaction`) that no unit test saw, all now fixed.** (i) **Two name spaces.** A definition is keyed by `bindingName`; `candidatePiNames`, the capability catalogue and every name the model can type are `piName`s. They are equal for every MCP proxy tool — which is why nothing had to say so before — and DIFFER for two of the nine (`NotebookEdit`/`notebook_edit`, `stopTask`/`stop_task`). Matching one space against the other defers seven of nine, silently, with every test green. Fixed with an explicit `semanticIdForDefinition` mapping, identity by default. (ii) **A deferred built-in LOST ITS EXECUTION PORT.** The MCP half gets one free because `proxySemanticPorts` is built from the raw `proxyTools` array; built-ins take theirs from `definitions`, which is the exact list deferral subtracts from. The model could search it, load it, see it registered, and every call would answer `missing_execution_port` with the bare semantic id as the reason. Ports are now built from the unfiltered set. (iii) **The registration controller keyed its candidate map by definition name** while `register()` is called with catalogue semantic ids, so those same two tools would have thrown `deferred-mcp-binding-denied` for a perfectly legitimate load. **A gate NARROWED rather than broken, recorded rather than absorbed:** C2's gate (d) claimed pinning every tool of a server turns the discovery surface off entirely. That is no longer true and cannot be — nine built-ins are candidates on every profile, so an empty MCP candidate list is not an empty candidate list. `alwaysLoad`'s actual promise is unchanged and is what the test now asserts, and `never` is asserted alongside it as the remaining full off switch, so the escape hatch stays a red-if-broken test instead of a claim in a comment. **Behaviour change worth stating: deferral now activates on a profile with NO MCP source at all**, because the nine are always there to defer. **BLOCKING, and it is why nothing is committed.** `pi-runtime-cwd-transaction` still fails. Diagnosis, not proof: its stub mocks `createPiSdkToolAdapter` to a pass-through, so its `workflow` probe deliberately bypasses `toolExecutor`, while the deferred-registration path does not — and the stub wires no permission bridge for it to reach. In production there is no such divergence (`tool-wrapper.ts:164` routes EVERY adapted tool through the same `deps.toolExecutor.execute`), so this looks like an artifact of that test's own mock. **"Probably the test" is exactly the reasoning this repo's guide warns against, and the path in question is permissions, so the row stays open until it is measured.** **The repair is bigger than one line, which is why it is not attempted here rather than half-done.** The hang is a real host round-trip: `permissionBridge` calls `requestPiPermissionReceipt`, which sends a `requestId` to the host and awaits a reply the harness never sends, so the probe stalls until the test's own 120 s timeout. Answering it needs a receipt that satisfies all fourteen fields `parseAndFreezePiPermissionReceipt` validates (sessionKey, provider, surfaceVersion, piName, bindingName, semanticId, descriptorId, manifestGeneration, manifestHash, provenance, responseEpoch, contextProfile, sandboxRequirement, plus single-use `decisionId`), and **no reusable fixture for one exists** — `pi-runtime-protocol.test.ts`'s receipt test asserts SOURCE TEXT, not behaviour. **A second breakage in the same file, found while diagnosing and easy to miss because it is SILENT:** the trailing `web_search` probe is written as `if (search)` over `customTools`, and `web_search` is now deferred too — so that probe stops running rather than failing, taking its `search_auth` evidence with it. **Both breakages share one root: this test's design assumes every built-in is reachable from `customTools`, and C7 invalidates that assumption for nine tools.** So the repair is either a permission-receipt fixture for the harness (which would turn the probe into a genuine end-to-end proof that a deferred built-in loads, registers, passes permissions and executes on a real server — the strongest evidence this row could carry) or a redesign of both probes. **The implementation is UNCOMMITTED and lives in the working tree**, deliberately: the failing check blocks the commit, and putting a red real-server test on a branch someone else pushes is the worse of the two errors. **UPDATE — the fixture is BUILT, GREEN and LANDED on its own (`79bc3c8f9`), and it works: permissions now round-trip and the probe gets the real `Unknown workflow recipe: rollback-isolation` refusal back from a genuinely executed deferred built-in.** Seven behaviour tests, including a negative control on the near-miss that would otherwise be rediscovered by every caller — the request's `manifestProvenance` is `[capabilityKey]`/`[]` while the receipt must carry `capabilityKey@generation`, so a straight copy parses and then fails the comparison. **The `if (search)` degradation is fixed in the same pass**: `web_search` reachability is now asserted, loading the tool the documented way and throwing when it is absent, so the probe can no longer stop running instead of failing. **What C7 is NOW blocked on is a different and larger thing than the fixture, and this is the measurement the decision asked for.** Reaching a deferred tool LOADS it, loading sets `toolsChanged`, and the active session is disposed and rebuilt — pre-existing behaviour for MCP loads, which C7 merely makes reachable through built-ins. `pi-runtime-cwd-transaction` counts sessions by ORDINAL in at least three independent places, so every rebuild renumbers it and each fixed ordinal uncovers the next: the stub's own `id === 2` create-delay (now rewritten to identify the PREPARE candidate by its cwd, which is the right shape regardless), a `dispose()` branch keyed on `id === 3`, and the probe assertions. Two of the assertions are already converted to intent — the first probe asserts the refusal rather than an incidental id, and the candidate-private probe asserts "not the candidate" against the captured candidate id, which is the claim it always meant. The run now gets as far as `dispose 2` and the PREPARE candidate is never created; that is the next thing to diagnose and it is not a fixture problem. **Per the 2026-08-16 decision, this is the "more than an hour's shape" case, reported rather than pushed through:** the fixture was the durable asset and it is banked; reconciling one long real-server test's ordinal bookkeeping with an extra session rebuild is its own piece of work, and extracting the three defects into their own committed fix is now the better trade if the owner wants C7's saving deferred. Evidence so far: 33/33 on the manifest + surface suites (new gates: nine-tool roll-call by name with the core seven asserted NOT deferred; off-switch removal with a negative control; three surface tests pinning the name-space mismatch), 533/533 across `pi-harness`, `tsc` clean on both packages, and the touched test file typechecked against a config WITHOUT the `*.test.ts` exclusion — 4 errors, all pre-existing, none added. Was: **UNBLOCKED by the owner's 2026-08-16 decision to flip deferral on — C2 is now work rather than a park, and C7 follows it. The dependency below is why it must still follow rather than run alongside.** Was: **BLOCKED ON C2, and the dependency is not in the row.** Step 0 established two facts the row does not state, and together they make building C7 now a cost with no benefit. **(1) The nine candidates are STATIC tools, not dynamic ones.** `deferredCandidates` is `dynamic.filter(tool => tool.source.kind === 'resolvedCapability' && !pinned)` (`harness-manifest.ts:600-602`); built-ins arrive through `staticTools(orchestrator)` and are never in `dynamic` at all. So C7 is not a predicate widening — it is moving nine tools from the static set into the dynamic one, which is the same blast radius C5 carries (permission layer keys off tool names, manifest hash changes, `validateDefinitions` throws for a manifest tool with no runtime definition). **(2) Deferral is OFF by default in both config sources** — `storage.ts:250` and `config-defaults.json:28` both set `deferredMcpToolLoading: false`, and `storage.ts:334` re-coerces it. **So a tool moved into the candidate set is not deferred in the default configuration and saves nothing.** C7's entire −3 640 is conditional on C2 flipping that default, and C2 is blocked on a live `tool_search` → `tool_load` case that has, in its own words, zero live proof today. Building C7 first would take C5-sized risk in exchange for a saving that only exists after another blocked row lands. **Marked `⏸` rather than `⬜`:** it is not un-started work waiting for someone, it is work that should not start until C2 does. The row's own safety gate — `disableWorkflows` and `NESSY_DISABLE_BACKGROUND_TASKS` must keep REMOVING their tools from the signed manifest rather than merely deferring them — remains the right fence when it is built; an off switch and a deferral are different states. |
| C8 window-scaled skill-listing budget | C | ✅ | `15e856c48` | **NO CHANGE MADE, and the reason is the row's own premise.** It says "upstream scales at 1% of the window — makes it BIGGER on large models". **That statement is not in the corpus.** Both relevant pages were fetched raw and searched: `agent-sdk/skills.md` and `context-window.md` contain **zero** occurrences of `1%`, and neither describes any percentage-of-window budget for the skill listing. Scaling our 4 000-character bound to a window fraction would have been a behaviour change built on an unverified number — and it would have made the listing GROW on exactly the models where the row assumed upstream grows it. **What the pages DO say, and we already match it:** the listing is "One-line descriptions of available skills so Claude knows what it can invoke. Full skill content loads only when Claude actually uses one" — progressive disclosure, which `buildSkillListingPart` implements, with a truthful `(N more skills not listed)` when the bound is reached rather than a silent prefix. **A real, citable DEVIATION found while checking, and it is ours-is-better rather than ours-is-wrong:** `context-window.md` says of the listing, "Unlike the rest of the startup content, this listing is not re-injected after `/compact`. Only skills you actually invoked get preserved." Ours lives in the STABLE cached prefix (`buildStableContextParts`), so it always survives compaction. Upstream's model therefore forgets which skills exist after a compaction and ours does not — cheaper per turn (cached, not re-sent) and more accurate. Recorded as a deviation so it is not rediscovered as a bug. **The 4 000-char bound is left as it is**, with its existing rationale intact: every character is paid on every request inside Pi's cached prefix, and a listing is a discovery aid rather than documentation. If the row's 1% figure has a source, it is not one this repo's corpus snapshot carries, and the citation rule says a Claude contract is checked against `scripts/claude-doc-pages.tsv`. |
| C9 refresh tool-search contract citations | C | ✅ | `0bb3acf65` | Raw page re-fetched with `curl` (`agent-sdk/tool-search.md`, verified present in `scripts/claude-doc-pages.tsv` first), and **both halves of the quoted sentence had moved**. Superseded: "Checks the combined token count of **all** tool definitions … If they **exceed** 10%". Current: "Counts the tokens in the tool definitions that tool search **can defer** and compares the total against the model's context window. When the total **reaches** 10% of the window, tool search activates." **Decision 1 — `>` → `>=`, a real behaviour change.** "Reaches" is `>=`; "exceed" was `>`. Our comparison was CORRECT against the wording of its day and drifted when the page was reworded — at exactly 10% upstream defers and we did not. The boundary is the entire decision, so the test now pins both sides: 20 000 fires, 19 999 does not, so `>=` did not quietly become "always". **Decision 2 — the narrowed denominator needed no change, and that is the finding.** The current page counts only deferrable definitions: "each MCP tool that isn't marked `alwaysLoad`, from any server, plus the built-in tools that load on demand", with core built-ins excluded because the SDK "always loads core built-in tools such as Bash, Read, and Edit upfront and doesn't count them toward the threshold". `candidateEstimatedTokens` was ALREADY that narrow set. **We do this correctly** — recorded at the field rather than left silent, so the next reader does not re-derive it. **Line numbers deliberately removed from the citations.** The file quoted `tool-search.md:38` and `:40`; the page has grown and those numbers no longer point at the rows they named. A quoted sentence does not decay. Evidence: `bun test .../config/__tests__/tool-search-settings.test.ts` → **9 pass / 0 fail** (8 → 9); `bunx tsc -p packages/shared/tsconfig.json` exit 0. **Control — disabled-source revert:** restoring `>` turns exactly the boundary row red (8 pass / 1 fail), restored to 9/0. |
| C10 spike: does the Codex binary already defer? | C | ✅ | `35d3dccb2` | READ-ONLY, as the row requires. **Answer: the binary supports deferral and we cannot reach it on our current integration shape — it is not a flag we are failing to set.** `deferLoading?: boolean` is real and pinned: `DynamicToolFunctionSpec` (`packages/codex-protocol/generated/v2/DynamicToolFunctionSpec.ts`) and the `DynamicToolNamespaceTool` variant in `schema/v2/ThreadStartParams.json`. It is a **per-tool property of a DYNAMIC TOOL NAMESPACE supplied at `thread/start`**. **We supply no such namespace.** Our `thread/start` carries `{ cwd, model }` and nothing else (`codex-agent.ts:380-383`), and our session tools reach Codex by a different route entirely — as MCP servers written into the emitted config (`[mcp_servers.session]`, `[mcp_servers.sources]`, `config-writer.ts:686/699`). `deferLoading` appears nowhere in our TypeScript outside the generated protocol, which is consistent: there is no namespace on which to set it. **Consequence for C5, and it is the useful half of this spike:** extending deferral to session tools is not a per-runtime flag flip. On Codex it would mean moving those tools off the MCP-server route and onto a dynamic namespace at `thread/start` — a different integration shape with its own permission, hook and catalog consequences — so C5's Codex arm is a design question, not a setting. That is worth knowing before C5 is scoped, which is why this row was taken before it. **CORRECTION 2026-08-16, verified independently against the pinned schema:** this row's phrase «a per-tool property of a dynamic tool namespace supplied at `thread/start`» is wrong, and «we supply no such namespace» understates the problem. `ThreadStartParams` has fifteen properties — `approvalPolicy`, `approvalsReviewer`, `baseInstructions`, `config`, `cwd`, `developerInstructions`, `ephemeral`, `model`, `modelProvider`, `personality`, `sandbox`, `serviceName`, `serviceTier`, `sessionStartSource`, `threadSource` — and **none of them accepts tools**. `DynamicToolSpec` sits in that file's `definitions` and is **reachable from no property in any schema file**: a walk of every `$ref` in `schema/**/*.json` returns **zero** references to it. **The inference drawn from that was WRONG, and it is corrected here rather than left standing:** «the protocol documents no field through which any client could supply one» does not follow. Upstream's own app-server README documents the field — *«`dynamicTools` on `thread/start` and the corresponding `item/tool/call` request/response flow are experimental APIs. To enable them, set `initialize.params.capabilities.experimentalApi = true`.»* — and **we already send that capability** (`codex-agent.ts:375`: `capabilities: { experimentalApi: true, requestAttestation: false }`, whose generated type documents itself as «Opt into receiving experimental API methods and fields»). The generator emitted the TYPE while omitting the PROPERTY, which is exactly what an experimental field excluded from schema generation looks like. **The orphan was evidence FOR the field, not against it.** The property scan was sound; the conclusion drawn from it was not. Door documented, permission already granted, field simply never populated — see [C12]. |
| C11 restore the IPC inventory generator | C | ✅ | `b39eaf0b8` | **Step 0 confirmed the absence a fourth time:** `ls scripts/ipc-inventory.ts` → No such file, while the test's own block says «Auto-generated by scripts/ipc-inventory.ts — DO NOT edit by hand». The only way to satisfy that comment was to hand-edit the exact list it forbids hand-editing, which is how three channels drifted silently until a release-gate `bun test` caught them. **A comment naming a tool that does not exist is worse than no comment — it tells a reader the drift is handled.** **The strongest available validation, and it is not a test I wrote:** the new generator reproduces the current frozen list **byte for byte**, 346 channels, `--check` exit 0 — so it agrees with the hand-written repair rather than replacing it with its own opinion. Wired as `ipc:inventory` / `ipc:inventory:check`, the latter appended to `validate:ci`. **Control — disabled-source revert:** deleting one channel line from the frozen block makes `--check` report STALE and **exit 1**; restored, exit 0. Both exit codes were read WITHOUT a pipe: the first attempt read `$?` after `tail` and got 0 from `tail`, the same laundering that made a failed dmg build look successful earlier in this train — the check is what CI branches on, so it had to be measured directly. **Two sibling registration contracts left alone, deliberately:** they catch registered-but-undeclared, a class this inventory structurally cannot see because it reads the declaration and nothing else. Folding them together would replace two independent checks with one blind spot. **A duplicate channel string exits 2 rather than being deduped into a passing list** — two declarations answering to one wire name is a defect, not a formatting question. Evidence: `bun test .../ipc-channels.test.ts` → **3 pass / 0 fail**. |
| C12 research: what it would take to reach Codex's deferral | C | ✅ | | **CLOSED 2026-08-16 by the orchestrator, with a NEGATIVE result that is worth more than the positive one would have been. Step 2 ran, and it kills the `[features]`-first route as a thing that can be validated by inspection.** Probe: the pinned `darwin-arm64/codex-app-server` (0.147.0) spawned against an isolated `CODEX_HOME`, one `initialize` with `experimentalApi: true`, four configs compared. Result — `[features] tool_search = true` + `tool_search_always_defer_mcp_tools = true` initializes cleanly (406 bytes of result, no stderr)… **and so does `[features] nessy_bogus_feature_xyz = true`, identically.** The table silently ignores unknown keys, so ACCEPTANCE PROVES NOTHING: writing our two keys and observing a clean start is exactly as informative as writing nonsense. **Without that control we would have shipped the flag and believed it worked.** **The detector was wrong twice before it was right, and that is the reusable part.** A first harness raced stdin EOF and reported one answering run per batch — first run in one batch, fourth in the next, with output not tracking the config at all. It would have supported any conclusion asked of it. Fixed by waiting for the response rather than for process exit, and by giving each config its own `CODEX_HOME` so no run inherits another's state. **What this leaves for whoever picks it up:** the config route is not refuted, it is UNVALIDATABLE BY INSPECTION — settling it needs a behavioural run (a real model, real MCP servers, a turn, and an observation of whether tools were deferred), which is a different size of experiment and belongs to the clean-runtime plan rather than here. Step 1's evidence stands unchanged and is not upgraded by this: the feature names sit in a contiguous serde run in both pinned binaries, which is evidence about strings. `dynamicTools` on `thread/start` remains the documented alternative, gated behind a capability we already send. \| — \| **STEP 1 IS ANSWERED FROM THE AUTHORITY, and the answer is: the flag route is a config write we ALREADY OWN. Parked there; steps 2 and 3 are not started.** **The decisive evidence is the pinned schema, not the binary** — AGENTS.md says the authority is `packages/codex-protocol`, and it settles this far better than the string search did. `config-schema.json` carries a top-level `features` property, described as *"Centralized feature flags (new). Prefer this over individual toggles."*, with **114 typed sub-properties** including **`tool_search: boolean`** and **`tool_search_always_defer_mcp_tools: boolean`** — declared and typed, not inferred. **And our own validator already accepts it:** `validateConfigAgainstSchema` fails only on a key absent from `properties`, and `features` is present, so emitting the table trips nothing of ours. **Three constraints the schema adds that the binary could not tell us.** (1) `features` is `additionalProperties: false`, so a misspelled flag is a config-LOAD failure rather than a silent no-op — the probe must spell both exactly. (2) **`direct_only_tool_namespaces` is NOT under `features`** — C10's row listed it beside the other two as though it were, and that conflated two different config locations. (3) **`non_prefixed_mcp_tool_names` is not a boolean** but a `$ref` to `FeatureToml_for_NonPrefixedMcpToolNamesConfigToml`, a structured toggle — which matters to the MCP wire-names work far more than to this row. `deferred_tool_world_state` is a plain boolean and is the third deferral-adjacent flag. **What is still owed is the whole of the actual question, and it is the "a typed field is not a filled field" trap by name:** the schema proves the key is ACCEPTED, not that the pinned binary HONOURS it for MCP-delivered tools. `buildCodexConfigToml` builds from a fixed structure with no escape hatch, so the probe is a small, well-scoped code change — append the table, run a session, observe whether our existing `[mcp_servers.session]` tools begin to defer. **Do not let a summary round this up to "the flag route works".** Step 2 (locate enforcement — whether permission, hook and capability gating live in `session-tools-core` or in the MCP TRANSPORT, which decides whether the owner's Codex-local shim is isolated or silently weakening) is untouched, and step 3 depends on it. Was: **STEP 1 (the door) partially answered from the binary; steps 2 and 3 not started.** **The ordering is now `[features]`-FIRST, and it is evidenced rather than assumed.** Premise verified: we emit no `[features]` table at all — `packages/codex-responses-adapter/src/config-writer.ts` writes exactly `[shell_environment_policy]`, `[mcp_servers.session]` and `[mcp_servers.sources]`, and nothing else. **The binary evidence, read from the pinned `darwin-arm64` `codex-app-server` (183 MB, 2026-08-13):** `tool_search` and `tool_search_always_defer_mcp_tools` sit in a CONTIGUOUS run of serde field names — `respect_system_proxy`, `multi_agent`, `multi_agent_v2`, `enable_fanout`, `enable_mcp_apps`, `apps_mcp_path_override`, **`tool_search`**, **`tool_search_always_defer_mcp_tools`**, `deferred_tool_world_state`, `non_prefixed_mcp_tool_names`, `unavailable_dummy_tools`, `tool_suggest`, `recommended_plugins`, `plugins` — and the same run appears in THREE separate blobs, which is what a features struct's field list looks like and not what incidental strings look like. All five probe names are present (`tool_search_always_defer_mcp_tools` ×3, `direct_only_tool_namespaces` ×8, `deferLoading` ×5, `dynamicTools` ×3, `experimentalApi` ×6). **Two neighbours nobody has named, and both earn a row somewhere:** `deferred_tool_world_state` is a second deferral-adjacent flag, and `non_prefixed_mcp_tool_names` bears directly on the MCP wire-names work already live-proven on three runtimes. **Both cautions from the row survive contact and are restated because each would have produced a wrong number:** a bare `tool_search` count is meaningless (most hits are wire item types — `tool_search_call`, `tool_search_output` — and an exact-line `grep` finds only ONE occurrence while the flag name really is present three times as a substring, so the two naive methods fail in OPPOSITE directions), and a `[features]` string count matches any bracketed text and returns garbage. **What this row has NOT done, stated rather than implied:** no live probe was run — writing `[features] tool_search = true` into the emitted config and observing whether our MCP-delivered session tools begin to defer is the actual Step 1 deliverable and it is still owed; Step 2 (locate enforcement — whether permission, hook and capability gating live in `session-tools-core` or in the MCP TRANSPORT, which is what decides whether the owner's Codex-local shim is genuinely isolated or silently weakening) is not started; Step 3 (cost the shim) depends on Step 2. **The `deferLoading` route is still the fallback and is unchanged**: it does not escape the same gate, since deferred dynamic tools are searchable only "when `tool_search` is available" — which is precisely why the flag route is tried first. Was: **READ-ONLY. Owner-requested 2026-08-16. Produces a design note and an honest cost, not an integration change** — the implementation, if we take it, is its own plan. **Method is PROBE-FIRST, not design-first**, and the order is fixed: **probe the door → locate enforcement → then cost the shim.** **Step 1 — probe, and the probe is now cheap and hack-free.** The entry point is DOCUMENTED, not smuggled: upstream's app-server README (`https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`, § dynamic tools) says *«`dynamicTools` on `thread/start` and the corresponding `item/tool/call` request/response flow are experimental APIs. To enable them, set `initialize.params.capabilities.experimentalApi = true`.»* — and `codex-agent.ts:375` already sends exactly that. **The earlier plan to smuggle a field through the free-form `config` bag is DROPPED; it was a guess and it is unnecessary.** So the probe is: send `dynamicTools` on `thread/start` against the pinned binary and watch whether it is accepted and whether `item/tool/call` comes back. **Three quoted details bind the design, so read them before writing the probe.** (i) *«Each function may set `deferLoading`. When omitted, it defaults to `false`. Deferred functions must belong to a namespace.»* — a flat list of session tools **cannot** be deferred; they must be grouped. (ii) Namespace names match `^[a-zA-Z0-9_-]+$`, ≤64 chars, and **must not collide with reserved Responses namespaces** — a list that includes `functions`, `multi_tool_use`, `file_search`, `web`, `browser`, `image_gen`, `computer`, `container`, `terminal`, `python`, `api_tool`, **`tool_search`**, `submodel_delegator`; tool names use the same charset, 1–128. (iii) **The gating condition for the entire idea:** *«When `tool_search` is available, deferred dynamic tools are searchable and can be exposed by a matching search result.»* — deferred-but-unsearchable means registered and invisible on an ordinary turn, so **whether `tool_search` is available in the version we pin is the row's first question**, ahead of everything else. The callback is fully specified and is what makes the shim viable: `item/tool/call` carries `{ threadId, turnId, callId, namespace, tool, arguments }`, wrapped by `item/started` / `item/completed` with `item.type = "dynamicToolCall"`, answered with content items (`inputText`, `inputImage`, `inputAudio`; remote HTTP image URLs and non-data audio are invalid). Namespace + tool + arguments is exactly the triple a translation layer needs to reach our existing handler. **Quote the sentences, not line numbers — the page will grow.** **Step 2 — locate enforcement, and this is the question that decides whether the shape is safe.** The owner's preferred shape is **Codex-local, a shim, touching no shared code** («желательно это сделать только для кодекс ввиде прослойки… что бы не задевать другие участки»), and the row costs *that* shape and says so if it turns out impossible. It is plausible: session tools already split into `packages/session-tools-core` (contracts and handlers, a library) and the bundled session MCP server, which is **one transport over them** — a dynamic-tool namespace would be a second transport over the same core, not a second set of tools — and the repo already has two shims of this form (the Claude runtime's per-session loopback adapter, `packages/codex-responses-adapter`). **The risk: if permission checks, hook dispatch or capability gating live in `session-tools-core`, the shim inherits them and is genuinely isolated; if any of them live in the MCP TRANSPORT layer, a second transport BYPASSES them** — a Codex-only weakening that **every existing test still passes**, because every existing test exercises the MCP route. That is this repo's recurring defect shape, enforcement sitting one layer above where it was audited. If enforcement is in the transport, say so plainly and **re-cost**: moving or duplicating it is a different size of job and it stops being «touches no shared code», which was the owner's whole reason for preferring the shape. **Step 3 — only then cost the shim**, sketch to cost rather than adopt: at `thread/start` enumerate the same tools as namespace entries carrying `deferLoading`; on the `DynamicToolCall` callback translate into the same core invocation the MCP server performs and answer with `DynamicToolCallResponse`; all inside the Codex path. Open questions at that point: **whether the wire names unified in the previous plan survive the move** (a silent re-name would undo live-proven work — a finding, not a footnote), how session tools map to namespace entries, and what happens to the capability catalogue. And: **is `deferLoading` HONOURED by the version we pin**, not merely present — the «a typed field is not a filled field» trap, which once hid twenty-seven real compactions. **Sources: the authority is the pinned protocol in `packages/codex-protocol`, not the docs site.** AGENTS.md is explicit that most of the `developers.openai.com/plugins/` tree is about ChatGPT apps and that a `plugins/` URL is not evidence of a Codex contract. Where docs and schema disagree, **the schema we ship against wins and the note records the disagreement**. **Scope: do not start the integration, do not change `codex-agent.ts` beyond a throwaway probe.** A large cost is a good result — the owner asked how, not for it to be done. |
| D1 a tool load before a cwd PREPARE loses the transaction candidate | C | ❌ | — | **REFUTED 2026-08-16 BY THE AUTHOR. There is no product defect here, the rule-8 stop was raised on a misattributed symptom, and the whole row below is kept only because the mistake is more useful than the claim.** **What actually happens:** with one `mcp__tool_load` in the run, `pi-runtime-cwd-transaction` blocks at a wait keyed on `apply_overrides` with **`sessionId === 1`** — a FOURTH ordinal site, ~60 lines BEFORE the PREPARE is ever sent. The load causes a rebuild, the active session becomes 2, the wait never matches, and the test times out there. **So the candidate was never created because it was never REQUESTED.** **The error in reasoning, named exactly, because it is the reusable part:** I measured that the captured message stream contained zero `working_directory_*` messages and read that as *"the server never answered"*. The correct reading is *"the test never asked"*. **I checked whether a reply came back without first checking whether the request went out** — and every downstream inference inherited it: the "one `registry_create` against the control's twelve" is explained by the same thing (no PREPARE, so no candidate registry), and the `try`/`catch`-always-replies argument, which was correct on its own terms, only made the wrong conclusion look better evidenced. **The positive control still holds and still proves nothing about the product:** without the load the test passes, because without the load there is no extra session and the ordinals line up. It demonstrates that the test is ordinal-sensitive, not that a transaction is lost. **Proof of the refutation:** dropping the `sessionId === 1` constraint from that one wait moves the failure forward by ~60 lines and turns a 122-second timeout into a 2-second assertion failure at the NEXT ordinal (`apply_overrides` asserted with `sessionId: 1`, whose own comment already says "the number is incidental to what this case proves"). **What is real, and it is the thing the peer and I both identified before this detour:** the test encodes session ordinals in about forty places, including a twelve-row table asserting the entire expected session sequence with cwds and strategies. Any change that adds a session rebuild breaks it, and reaching a deferred tool adds one. That is test fragility of a known class, not a session-lifecycle defect, and converting it from counting to identifying is the work C7 is actually blocked on. **C7 is therefore blocked on a TEST REWRITE, not on a product decision, and no serialization design is needed** — the owner's approved serialization was already retired by the previous stop, and this refutation removes the premise for it entirely. **Superseded claim, kept verbatim below so the reasoning can be audited rather than trusted:** **RULE-8 STOP, raised 2026-08-16. This is a defect in machinery 1.28.0 ALREADY SHIPS ON BY DEFAULT, and it is NOT C7.** **Reproduced with C7's product code stashed**, so built-in deferral is not involved: one `mcp__tool_load` call during a turn, then a cwd PREPARE, and the transaction candidate is **never created** — the run wedges and no further session appears at all. **Positive control, which this repo requires before any absence claim:** the identical test with NO load, same stashed state, PASSES and runs its full twelve-session sequence, creating the candidate on `next-cwd` and firing `session_create_delayed` while the original session is still alive. So the absence is caused by the load, not by the harness. **Sequence in the broken run:** `session_create 1 (old-cwd)` → load → `dispose 1` → `session_create 2 (old-cwd)` (the server logs *"Recreating session due to tool changes"*) → a turn runs on 2 → `dispose 2` → **nothing**. **A second signal that narrows it:** the broken run records exactly ONE `registry_create`, while the control records twelve — the PREPARE never reaches even its own registry creation, so the candidate is not created-then-disposed but never started. That distinguishes the two hypotheses: it is **not** "created and immediately disposed with the probe looking at the wrong moment". **Why it is reachable today:** `mcp__tool_load` is on every session's surface as of 1.28.0, the model calls it whenever it needs a deferred tool, and `onLoadToolNames` sets `toolsChanged` — the same rebuild the log shows. A user whose agent loads a tool and then changes the workspace directory is on this path. **SHARPENED 2026-08-16, and the new fact rules out the shape I was about to build.** The server sends a `working_directory_transaction_result` from BOTH arms of a `try`/`catch` that wraps the whole PREPARE handler — so a refusal would still reply. **It replies with nothing at all**: the captured message stream contains ZERO `working_directory_*` messages. So PREPARE is not being REFUSED by its own guard (`Cwd prepare requires an active Pi runtime`, which would surface as `success: false`); the handler either never runs to completion or is never dispatched. `createAuthenticatedRegistry` is the first thing in that handler that leaves a trace, and it leaves none — consistent with the single `registry_create` already recorded. **A second marker narrows where the stall begins:** in the control the stub records `set_thinking_level` after `set_model`; in the broken run `set_model` is the last thing the stub sees. The message pump stops advancing there, which points at a handler that never returns rather than at the transaction's own logic. **And `dispose 2` is teardown, not a wedge** — it is the last event because the harness times out and kills the child, whose shutdown disposes the active session. The earlier reading of it as "the rebuild disposed the session and failed to recreate it" was wrong and is corrected here. **Consequence for the fix, and it is why this is a second stop rather than a build:** the owner's decision was to SERIALIZE the tools-changed rebuild against an in-flight cwd transaction. Serialization is a fix for two operations that interleave badly — but the evidence now says the transaction handler is not reached at all, so a queue placed around it could make the symptom disappear without the cause moving. **The hang point is not yet located, and locating it is the next step**, not designing around it. **Not diagnosed further and NOT worked around, deliberately:** the next step is a product question about how a tools-changed rebuild interacts with an in-flight cwd transaction, and it is owed a decision before anyone writes code. C7 is blocked behind it — C7 makes the load path far more frequent, so landing C7 on top of this would multiply the exposure rather than cause it. |
| M1 key-mismatch migration | K | ✅ | `38b52d158` | **Step 0: every stub coordinate verified correct** — `getStableMachineId()` is `secure-storage.ts:92-126` with the silent fallback at the tail, and the migration-on-read shape is real at `:699-714`. **The gap is narrower than the plan states, and naming it is the whole fix.** Two keys were tried: `deriveStableKeyV2` (the identity as it is NOW, v2 recipe) and `deriveLegacyKeyV2` (hostname+username+homedir, **v1** recipe). The owner's store is keyed to the FALLBACK identity under the **v2** recipe — neither of those. Added `deriveFallbackIdentityKeyV2` as a third attempt plus the same re-encrypt the legacy path already does. **Correction to the task text, coordinates not approach, so no rule-8 stop:** the plan asks for the reverse direction too («and vice versa»). It is **not implementable** — a store written under the hardware UUID and read where that read now fails cannot be opened by trying harder, because the UUID is exactly what could not be obtained. Writing that derivation would put a key in the file that can never succeed; the file says so instead. Evidence: `bun test .../backends/__tests__/secure-storage.test.ts` → **21 pass / 0 fail** (18 → 21), `bunx tsc -p packages/shared/tsconfig.json` exit 0. **Control — disabled-source revert:** replacing the third `tryDecryptV2` with `null` turns exactly the migration row red (**20 pass / 1 fail**), restored to 21/0. Fixture writes the file BY HAND (`MAGIC\|FLAGS\|SALT\|IV\|TAG\|CIPHERTEXT`) rather than mocking `getStableMachineId` — `mock.module` is process-global here and a spread-less replacement un-implements every other export for every file loading after it. **Negative subject:** structural damage must still report `bad magic bytes`, so "always claim a machine-identity mismatch" cannot pass. **Fail-closed asserted:** the file is byte-identical after a failed read. **Finding recorded, NOT fixed — it is not this task's deliverable and it changes behaviour for every caller:** `CredentialManager.get()` catches every backend error and returns `null` (`manager.ts:160-162`), so a corrupt/unopenable store reads as "no credential" through most typed accessors — measured, `getApiKey()` RESOLVES with `null` — while `getRemoteServerToken()` propagates. That is why the packaged app reported keys merely absent, and it means M1's honest message is invisible on that path until the swallow is addressed. |
| M2 v1 backend quarantine | K | ✅ | `c0664c49c` | **Step 0 checked the format-reader need first, as the task demands, and it changed the shape of the answer.** v1 is unreachable in production — enumerated: `initializeCredentialManagerV2` is the only construction site (`manager.ts:789`) and passes a v2 backend, `getCredentialManager()` throws without it, and the two `new SecureStorageBackend()` sites (`manager.ts:78`, `:89`) sit on init branches a constructor-supplied backend never reaches. But the class **reads the pre-W10 v1 FORMAT** and that contract has its own live test (`SecureStorageBackend pre-W10 compatibility`). So the class STAYS and the hazard goes: `handleCorruptedFile` ran `unlinkSync` on three read paths, one of which is **"both keys failed"** — which is not corruption but exactly the case lane K exists for, a valid store under a different machine identity. On that path a READ destroyed the user's credentials. Deletion removed; fail-soft-return is unchanged. **This is the AGENTS.md "enforcement one layer up" shape**: the identifier was unreachable while the consequence was catastrophic, so the consequence was verified separately from reachability. Evidence: `bun test .../backends/__tests__/secure-storage.test.ts` → **22 pass / 0 fail** (21 → 22), `bunx tsc -p packages/shared/tsconfig.json` exit 0, and `grep -n unlinkSync` leaves only the atomic-write temp cleanup (`:869`). **Control — disabled-source revert:** restoring the `unlinkSync` line turns exactly the quarantine row red (**21 pass / 1 fail**), restored to 22/0. |
| N1 a refusal reaches the renderer with its code | N | ✅ | `21d30d6c9` | **The seam named in the moved row was wrong and Step 0 corrected it:** this channel is the WebSocket RPC client, whose halves are both correct (`server.ts:688` maps through `isErrorCode`; `client.ts:594-598` re-attaches `err.code`). The loss is at `contextBridge`. **Measured, three channels shut:** own property `code` → gone (`getOwnPropertyNames` → `["stack","message"]`), `name` → gone (`CodedError` sets it, renderer reads `Error`), `stack` → **REGENERATED**, one line, zero frames. `message` survives and is translated, so it is not a channel. A first fix smuggled the code through `stack`, shipped into a packaged build and was **inert**; reverted. **Second correction, and it decided the design:** `window.electronAPI` is `writable: false, configurable: false` and the object is FROZEN (measured live), so a renderer-side wrapper cannot replace it. The preload therefore exposes the raw surface as `__nessyRpcRaw` and the renderer publishes `window.electronAPI` itself, from `main.tsx`'s FIRST import — module bodies run before the importer's statements, so an install written as a statement would run after every transitive module could already have read the global. Safe because none of the **610** `window.electronAPI` reads binds it at module scope. **Built from the CHANNEL MAP, not by walking the object**, which is what covers the 39 methods one level down (`capabilities` 14, `browserPane` 13, `marketplace` 11, `plugin` 1) and leaves listeners alone (they return an unsubscribe function, not a promise). Evidence: `bun test .../shared/__tests__/rpc-error.test.ts` → **9 pass / 0 fail**; `apps/electron` `tsc --noEmit` exit 0; **live on a packaged build, RTS-8 → PASS**, error shape at the renderer `{ownKeys:["stack","message","code","name"], code:"SESSION_BUSY", name:"CodedError", stackLines:4}` where it was `{ownKeys:[], name:"Error"}` before. **Control — disabled-source revert:** forcing the map to look flat turns exactly the nested-invoke row red (8 pass / 1 fail), restored to 9/0. **Negative subject:** an uncoded failure must not gain a code, asserted; and a DTO carrying a `message` field must not be mistaken for an envelope. |
| M3 decryption failure stops reading as "no credential" | K | ✅ | `f3e9cd61c` | Owner decision 2026-08-15, **narrow variant**. `CredentialManager.get()` caught every backend error into a debug line and returned `null`, so "the store could not be opened" and "no credential is stored" reached all nine typed accessors as the same value — which is why the packaged build showed empty connections rather than M1's sentence. **Only the different-identity failure propagates**; structural damage and an absent store keep today's silence. The full un-swallow trades one false answer for a worse one: a new user with no store would meet errors where "you have not added a key" is honest. **Discriminated by a FIELD, not by the sentence** — `CredentialStoreCorruptError.kind` is `'corrupt' \| 'foreign-identity'`, because the message is user-facing and a caller matching on it is a defect scheduled for the first rewording. The manager's guard is structural (`err.kind === 'foreign-identity'`) rather than `instanceof`, so it does not couple to a backend it otherwise reaches only through the interface. **Product addition the owner asked for:** the message now names the WAY OUT, not just the cause — entering the key again writes a fresh entry under the current identity and leaves the old file untouched. The fear this failure produces is "my keys are gone"; they are not. **No i18n key involved:** this is an Error message in `packages/shared`, the layer that has no `t()`, so locale parity does not apply — flagged rather than assumed. Evidence: `bun test .../backends/__tests__/secure-storage.test.ts` → **24 pass / 0 fail** (22 → 24), `bunx tsc -p packages/shared/tsconfig.json` exit 0. **Control — disabled-source revert:** disabling the guard turns exactly the propagation row red (23 pass / 1 fail), restored to 24/0. **Negative subjects, both:** no store at all still returns `null`, and a structurally damaged file still returns `null`. |

## C2's original park note

Superseded by the owner's 2026-08-16 decision to flip deferral on, and kept
because it records what the row was blocked on and why.

**Was `⏸`, and deliberately not flipped.** The remaining gates are real and none is inference: (a) the 43-tool capability roll-call; (b) the flip must land in **both** `storage.ts:250` and `apps/electron/resources/config-defaults.json:28` — both currently `false`, and `storage.ts:334` re-coerces, so a one-place flip works in a running session and reverts on the next launch, testing green and shipping nothing; (c) a real UI control, since the preference is reachable only by env var today; (d) `alwaysLoad` still pinning a server past the default; (e) the uncached-source floor still outranking a `false` override. **This row changes behaviour for every session on every runtime**, so it is the last one on this plan that should move on estimate. What it now needs is mechanical work, not a missing capability — which is a different kind of blocked than it was written as, and **C7 is parked behind exactly this row**.
