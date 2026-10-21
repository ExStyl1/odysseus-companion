# S14 — Tool search and deferred tool loading

**The owner found this row by reading the tracker.** It sits at
`2026-07-25-nessy-claude-parity-audit.md:439` marked `⬜` and explicitly
**"unowned"** — identified during the audit and never assigned to any plan. It is
the only unowned row in that comparison table.

I verified before writing this, applying my own rule about absence claims: no
plan covers it, and `TOOL_SEARCH`/`toolSearch` appear nowhere in the tree. The
`deferredToolUse` symbols in `pi-agent.ts` are a **different concept** — deferring
a tool *call*, as in the permission `defer` decision, not deferring tool
*loading*. Do not mistake one for the other.

**The row's own statement of consequence:** users pay the full tool-definition
token cost where Claude pays almost none.

| | Claude | Ours |
| :-- | :-- | :-- |
| Default | on | **off** |
| Trigger | activates at 10% of context | a fixed **count threshold of 48** |
| Override | `ENABLE_TOOL_SEARCH`, plus per-server control | none |
| Exemption | `alwaysLoad` | none honoured |

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/agent-sdk/tool-search.md` — already named in
   `AGENTS.md`'s contract map — plus `.../mcp.md` for `alwaysLoad` and
   `.../context-window.md` if the trigger is defined there. Take the page list
   from `curl -s https://code.claude.com/docs/llms.txt`. **Never a summarising
   fetch tool**: it invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Read the whole line.
3. **Read around each quotation.** The trigger, the default and the override are
   likely three sentences in one neighbourhood, and getting the *relationship*
   between them wrong is the failure mode here — an env override that outranks the
   wrong thing is worse than none.
4. **Declared ≠ enforced.** Prove it on **Pi**, the shipped default.
5. **Two git commands** — pathspec on the `commit`; note 11c on shared files.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. Reproduce on a
   clean `git worktree`, never `git stash`.
7. **`rg` skips NUL-containing files silently; eight of ours have one** — use
   `grep -a` for absence claims.
8. **A CDP dev instance may be running on port 9223.** Do not kill or drive it.

---

## 1. Task 1 — what the contract actually says

**Commit:** `docs(tools): the tool-search contract, measured against ours`

Before changing behaviour, write down the contract and our position against it,
field by field, in this plan's § 5. Four questions the table above raises and
this task must answer from the page:

- **What exactly triggers it?** "10% of context" needs its denominator: 10% of the
  window spent *on tool definitions*, or of the window overall? Our threshold is a
  **count**, which is a different quantity, and the difference decides whether one
  can be expressed as the other at all.
- **What does the default being on imply for us?** We are a bank fork with a
  count threshold; flipping a default changes every existing session's tool
  surface. Say what would move.
- **Is `alwaysLoad` a pin past search, or past a different mechanism?** Our MCP
  descriptor already carries `alwaysLoad` (B1's timeout audit confirmed it is
  parsed and persisted) — find out whether the docs make it exempt from *this*
  and whether anything reads it today.
- **What is the per-server control, and do we have a place to put it?**

**This task may legitimately conclude that part of it should not be built.** Say
so with a category string rather than implementing a rule you cannot express.

---

## 2. Task 2 — the trigger, the override, and the exemption

**Commit:** `feat(tools): deferred tool loading follows the documented trigger`

Implement what Task 1 established. Constraints that are not negotiable:

- **The tool manifest is hash-pinned.** `PI_STATIC_MODEL_CONTRACT_HASHES` is
  compared against the subprocess's live schema, and a composition-dependent
  schema kills the session's first turn with `Pi execution manifest model contract
  mismatch`. This repo has already shipped that bug twice — once from a
  `maxItems` derived from config, once from a tool name inside a description. **If
  your change makes the model-visible surface vary with context, the pins must be
  recomputed and the mechanism must still be composition-stable.** Read
  `pi-agent-server/src/harness/live-manifest-contract.test.ts` before touching the
  descriptor.
- **A tool that disappears must not become a tool that silently cannot be
  called.** If deferral hides a definition, the call path must either load it on
  demand or refuse with a message naming what happened. A model asking for a tool
  that "exists but is not loaded" and getting a generic failure is the
  declared-versus-enforced split in a new place.
- **Never widen by accident.** If the trigger changes, the *set* of tools the
  model can reach must not grow — only when it is shown must change.

**Gate:** a session below the threshold sees the full surface; one above sees the
deferred surface and can still reach a deferred tool; an `alwaysLoad` server is
exempt; and the env override does what the page says it does. Plus the manifest
pin check, green.

---

## 3. Task 3 — what stays open

**Commit:** `docs(tools): the tool-search surfaces we do not implement`

Category strings, including the per-server control if it needs a settings surface
this slice should not grow, and the default-on flip if you recommend leaving it
off.

**Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters** — five ways of losing half a register row have been found.
Confirm with `python3 scripts/regenerate-deviation-register.py | grep -i "tool.search\|deferred"`.

---

## 4. Gate

Focused suites for every changed file, plus `packages/pi-agent-server` and the
harness-contract suite; `bun run typecheck:all`; `bun run lint`;
`git diff --check`.

**This is a shared wire/schema surface — a named risk trigger.** Run the expanded
set once on the final diff, and **rebuild the staged bundles**
(`bun run electron:build:servers`) if you change a pin, because a stale bundle
enforces the old schema and kills a live first turn. That failure has been shipped
before.

**Run every test from the repository ROOT.**

---

## 5. Findings

Pages fetched with `curl -s` on 2026-07-30, all HTTP 200:
`agent-sdk/tool-search.md` (12 KB), `agent-sdk/mcp.md` (33 KB), `mcp.md` (81 KB),
`context-window.md` (58 KB), `agent-sdk/agent-loop.md` (45 KB),
`env-vars.md` (334 KB). Line numbers below are from those files.

### 5a. The row's own summary does not survive the page

Three of the row's four fields are wrong, and the first one is wrong in a way
that changes what Task 2 should build.

**"On by default, activates at 10% of context" conflates two different rows of
the same table.** They are alternatives, not a sequence. Default-on is
**unconditional**: `tool-search.md:38`, the `(unset)` row — "Tool search is on.
Tool definitions are deferred and discovered on demand." No threshold is
consulted. The 10% belongs to a *different, opt-in* value:
`tool-search.md:40`, the `auto` row — "Checks the combined token count of all
tool definitions against the model's context window. If they exceed 10%, tool
search activates." So Claude's default is not "defer past a threshold", it is
"defer everything, always"; the threshold mode is what you ask for when you do
not want that. `mcp.md:1167` states it from the other side — "If you prefer
threshold-based loading, set `ENABLE_TOOL_SEARCH=auto`".

**"`ENABLE_TOOL_SEARCH` and per-server control" and "no `alwaysLoad`
exemption" are the same field counted twice.** The per-server control *is*
`alwaysLoad`. `mcp.md:1221`: "If a server's tools should always be visible to
Claude without a search step, set `alwaysLoad` to `true` in that server's
configuration."

**"no `alwaysLoad` exemption honoured" is stale — we honour it.** P5 landed the
parse (`mcp-pool.ts:1775 alwaysLoadProxyToolNames`, both the server-config and
the per-tool `_meta["anthropic/alwaysLoad"]` forms), `pi-agent.ts:1605-1632`
threads it onto every dynamic tool, and `harness-manifest.ts:503-506` makes a
pinned tool neither a deferral candidate nor part of the count that decides
deferral. Two tests already assert it (`harness-manifest.test.ts:269,298`).

**"Off by default, count threshold of 48, no env override" is correct.**

### 5b. Field by field

| Field | Claude, verbatim source | Ours | Verdict |
| :-- | :-- | :-- | :-- |
| Scope of deferral | MCP + custom-SDK-MCP tools only; `agent-loop.md:242` "Built-in tool schemas load every request", `tool-search.md:46` "applies to all registered tools, whether they come from remote MCP servers or custom SDK MCP servers" | `isDeferredMcpCandidate` (`deferred-mcp-tools.ts:56`) = `mcp__*` minus `mcp__session__*`; `harness-manifest.ts:504` further restricts to `source.kind === 'resolvedCapability'` | **match** — and our extra exclusion of `mcp__session__*` is right: those are built-ins wearing an MCP prefix |
| Default | on, unconditional (`tool-search.md:38`) | off (`config/storage.ts:173 deferredMcpToolLoading: false`) | **gap**, deliberately kept — see 5c |
| Trigger, threshold mode | token count of all tool definitions ÷ model context window > 10%; `auto:N` for N% (`tool-search.md:40-41`, `env-vars.md:393`) | count of deferrable candidates > 48 (`harness-manifest.ts:507`) | **not reconcilable** — see 5d |
| Partial vs total deferral under threshold mode | the docs disagree with themselves: `tool-search.md:40` "If they're under 10%, all tools are loaded into context normally" (all-or-nothing) vs `mcp.md:1167` "load schemas upfront when they fit within 10% of the context window and defer only the overflow" (partial) | all-or-nothing (`harness-manifest.ts:539`: candidate list is either every candidate or empty) | **doc conflict**; we follow `tool-search.md`, the page whose subject this is |
| Env override | `ENABLE_TOOL_SEARCH` ∈ unset / `true` / `auto` / `auto:N` / `false` (`tool-search.md:36-42`) | none — `grep -a` over the whole tree finds `ENABLE_TOOL_SEARCH` only in docs | **gap**, Task 2 |
| Override precedence | env overrides the platform default: `tool-search.md:34` "You can override either default with the `ENABLE_TOOL_SEARCH` environment variable" | n/a | Task 2: env outranks `deferredMcpToolLoading` |
| A higher precedence still | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` wins over `ENABLE_TOOL_SEARCH` (`tool-search.md:44`, `env-vars.md:228`) because it strips the beta header carrying `defer_loading` and `tool_reference` | **N/A** — see 5e | won't-implement |
| Per-server exemption | `alwaysLoad: true` on the server config; "Every tool from that server then loads into context at session start **regardless of the `ENABLE_TOOL_SEARCH` setting**" (`mcp.md:1221`) | implemented (5a) | **match**; Task 2 adds the "regardless of the override" arm |
| Per-tool exemption | `_meta["anthropic/alwaysLoad"] === true` (`mcp.md:1237`) | implemented (`mcp-pool.ts:1782`) | **match** |
| `alwaysLoad` side effect | also blocks startup until the server connects, capped at 5 s (`mcp.md:1239`, `agent-sdk/mcp.md:153`) | not implemented — our pin is context-only | out of scope (a connect-timing item, not a loading item) |
| What loads at session start when deferred | "Only tool names and server instructions load at session start" (`mcp.md:1157`); "The agent receives a summary of available tools" (`tool-search.md:20`); `context-window.md:47` "MCP tool names listed so Claude knows what is available" | **neither.** `prompt-composer.ts:20-21` filters every candidate out of the tool-contract listing, and `grep -a` finds no MCP `instructions` field anywhere in `mcp-pool.ts` | **gap**, and the one that makes a default-on flip unsafe today — see 5c |
| Results per search | "up to five most relevant tools per search by default" (`tool-search.md:158`) | default 20, max 50 (`deferred-mcp-tools.ts:21`), output additionally capped at 32 KB | **ahead / different** — ours returns more per round-trip, which is the right trade when we have no name list |
| Tools loaded per step | "Up to five of the most relevant tools are loaded into context by default" (`tool-search.md:20`) | uncapped (`mcp__tool_load` takes `names[]`) | **different**, deliberate: same reason |
| Catalog ceiling | 10,000 tools (`tool-search.md:157`) | none | not a gap worth code |
| Survives compaction | "previously discovered tools may be removed, and the agent searches again as needed" (`tool-search.md:20`) | leases are revalidated per generation and a removed candidate is revoked (`deferred-mcp-tools.ts:222-237`) | **match** |
| Fallback when the mechanism is unavailable | `WaitForMcpServers` (`mcp.md:189`) | none | see 5f |

### 5c. What the default being on would move

Two things, and the second is why the flip is not part of this slice.

1. `deferredMcpToolLoading` **has no user-facing surface at all.** It exists in
   `config-defaults-schema.ts:54`, `validators.ts:128`,
   `resources/config-defaults.json`, and is read once at
   `pi-agent.ts:1672`. `grep -a` finds no settings page, no i18n key, no IPC
   writer. So today the feature is not merely off — it is unreachable except by
   hand-editing `~/.nessy-agent/config.json`. Flipping the constant flips it for
   **every** existing session with no way to turn it back off in the app.
2. **We do not advertise the deferred tools' names.** Claude's default-on is
   safe because the names stay in context (`mcp.md:1157`,
   `context-window.md:47`) and only the schemas leave. Ours removes the tools
   from `composePiHarnessPrompt`'s listing entirely, so a defaulted-on session
   asks the model to search a catalog it has not been told exists. That is a
   *findability* regression dressed as a context saving, and it is a bigger
   change than a boolean.

Measured cost, so the trade is not asserted from feel: 51 `mcp__session__`
tool definitions cost **12,735 estimated tokens**, mean **250 tokens per tool**
(`estimateTokens`, 4 chars/token). Claude's own figure is "50 tools can use
10-20K tokens" (`tool-search.md:13`) — our estimator lands inside its band, so
it is fit for the threshold arithmetic in 5d.

**Recommendation: leave the default off, ship the override, and record the flip
as blocked on the name listing.** Category string in Task 3.

### 5d. Is a count reconcilable with a percentage? No.

At 250 tokens/tool, 48 deferrable tools ≈ **12,000 tokens**. Against Claude's
10%:

| Model context window | 10% of it | 48 tools as % | Our count fires |
| :-- | :-- | :-- | :-- |
| 1,000,000 | 100,000 | 1.2% | ~8× too late |
| 200,000 | 20,000 | 6.0% | ~1.7× too late |
| 131,072 | 13,107 | 9.2% | about right |
| 32,768 | 3,277 | 36.6% | ~4× too late |

A fixed count is a percentage **only for one window size** — about 120K — and
the error grows in both directions. It is window-blind by construction, so
`auto`'s rule cannot be expressed as a count, and 48 cannot be re-derived as a
percentage. They are different quantities, exactly as § 1 suspected. The two
therefore ship as two different values of one variable, not as one recast as
the other.

`auto:N` **is** implementable at our seam, and at the right seam: the deferrable
set is precisely the dynamic MCP tools, and those carry `description` +
`modelSchema` in the host manifest, so their size is measurable where the
decision is made. The model's window is already on the agent
(`pi-agent.ts:940 catalogContextWindow`, from `ModelDefinition.contextWindow`).
Two honest limits, both recorded rather than hidden: the count is an
**estimate** (4 chars/token, not a tokenizer), and the window is **unknown for
arbitrary gateway models** — `nestor.ts:61` leaves `contextWindow` absent when
neither the API nor `NESTOR_GATEWAY_MODEL_WINDOWS` supplies one, and
`models-pi.ts:41` can too. With no window there is no percentage, so `auto`
must fall back to something stated, not silently do nothing.

### 5e. Why the beta-header rules do not apply to us

Claude's tool search is an **API mechanism**: `defer_loading` on tool
definitions plus `tool_reference` content blocks behind an `anthropic-beta`
header (`tool-search.md:44`, `env-vars.md:228`). Every fallback in the page is
downstream of that wire dependency — off on Google Cloud's Agent Platform, off
when `ANTHROPIC_BASE_URL` is non-first-party "since most proxies do not forward
`tool_reference` blocks" (`tool-search.md:34`), off on Azure-hosted Microsoft
Foundry because the deployment rejects it server-side.

Ours is a **client-side** mechanism: two ordinary tools, `mcp__tool_search` and
`mcp__tool_load`, and a host-side catalog. No beta header, no `tool_reference`,
no `defer_loading`. Consequences, both load-bearing:

- The whole family of platform fallbacks is **N/A** for us, including
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`. Porting them would port a
  dependency we do not have.
- The one Claude fallback that would otherwise bite hardest is the
  non-first-party `ANTHROPIC_BASE_URL` one — and **the Nessy Gateway is exactly
  that host.** On Claude's rules our own default connection would fall back to
  upfront loading. Because our mechanism is client-side, it does not. That makes
  default-on *more* defensible here than upstream, which is worth stating
  plainly: the reason to keep it off is 5c's missing name list, not the wire.

### 5f. `false` cannot be allowed to strand an uncached source

`harness-manifest.ts:509` turns discovery on whenever
`hasUncachedMcpSource` — a desired server that has contributed no descriptors
yet, so there is nothing to load upfront and no way to reach it without a
search step. Claude's answer in that situation is a different tool:
`mcp.md:189` — "In configurations without tool search … Claude uses the
`WaitForMcpServers` tool instead."

We have no `WaitForMcpServers`. So an `ENABLE_TOOL_SEARCH=false` that also
killed the uncached-source fallback would do what the page says and still be
wrong for us: it would remove the only path to those tools and report nothing.
The override therefore governs the **preference and the threshold**, and the
uncached-source fallback stays an unconditional floor. Stated, not silent —
category string in Task 3.

### 5g. Nothing in Task 2 changes a model-visible schema, but one pin becomes live-critical

Flipping the trigger changes which tools are **present**, never any tool's
shape. Checked, not assumed:

- `presentationReplacements` (`tool-manifest.ts:300-317`) only emits a rewrite
  for a name that differs from its `piName`. `mcp__tool_search` and
  `mcp__tool_load` have `bindingName === piName`, so their appearing or
  disappearing cannot alter any other tool's projected text.
- Both discovery tools are pinned (`harness-tool-descriptor.ts:58-59`), and I
  verified by driving the real `buildDeferredMcpToolSurface` against the real
  `hashProjectedPiToolDefinition` that both pins match today. No latent
  first-turn failure exists at HEAD.
- But **no test exercises them**: all three compositions in
  `live-manifest-contract.test.ts:222-231` leave deferral off, so
  `harness-manifest.ts:513` filters both discovery tools out and the loop at
  `:237` skips them for want of a definition. Two pins in the table are
  unproven. Making deferral reachable by env is exactly what turns that from
  latent to load-bearing, so Task 2 adds a deferral-on composition.

### 5h. Does the per-server control have anywhere to live? Yes, and it is already there.

Three declaration surfaces, all live: an MCP source's own config, a
`.mcp.json` entry (`mcp/__tests__/always-load-config.test.ts:56`), and a Claude
plugin manifest's MCP server (`format-adapters/claude.ts:1013`), plus the
per-tool `_meta` form. The question § 1 asks — whether it needs a settings
surface this slice should not grow — answers itself: it is a *server* property,
so it lives with the server, and no new UI is required for parity.

---

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent is working concurrently in `packages/shared/src/plugins/` and
  `packages/shared/src/marketplace/`** (plugin dependencies and monitors). Stay
  out of both.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 7. Report

Commit shas; the line you found each quotation at; **the § 5 field-by-field
table**; **every correction to this plan** — including whether the row's own
summary of Claude's behaviour survives reading the page; whether the count
threshold and the context-percentage trigger are reconcilable; what you did about
the pins and whether bundles needed rebuilding; the category strings with proof
they appear in the register; and the mutation probe.

---

## 8. What stays open

Six deviations. Two of them are the same missing piece wearing two hats, which is
the finding this task exists to record: the *name listing* is simultaneously why
the default cannot be flipped and why a deferred tool's direct call cannot be
refused informatively.

`documented, not implemented — Claude defers every MCP tool by default and ours stays off, because Claude's default is safe only where tool NAMES remain in context while the schemas leave, and we list neither names nor server instructions once deferral is on. Flipping the boolean alone would hide the catalogue from the model instead of shrinking it, so the name listing has to land first.`

`documented, not implemented — the tool names Claude keeps in context when schemas are deferred, plus the MCP server instructions beside them. Not a subprocess tweak: a name-only placeholder is projected back to full size, because projectPiToolDefinition rebuilds a dynamic tool from the manifest modelSchema and not from the runtime definition, so it needs a manifest change and its own slice.`

`documented, not implemented — an informative refusal when the model calls a deferred tool by name. Pi answers Tool X not found from its own loop, and that branch returns before beforeToolCall, so no host hook can name the deferral. The only interception seam is a registered definition, which is the name listing above. Search output plus the load tool guidance is the whole mitigation today.`

`documented, impossible on the uncached-source path — the false value cannot switch discovery off for a desired MCP server holding no cached descriptors. Claude reaches such a server with WaitForMcpServers instead and we ship none, so obeying false there would delete the only route to those tools and report nothing. The override governs the preference and the threshold; this floor stays unconditional.`

`documented, inapplicable — every platform fallback on the tool-search page, including CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS and the non-first-party base-URL rule that would otherwise cover the Nessy Gateway. Each exists because Claude tool search is an API beta carrying defer_loading and tool_reference blocks; ours is two ordinary tools over a host catalogue, so no header exists to strip.`

`documented, not implemented — the startup block alwaysLoad also imposes, capped at five seconds, so a pinned server's tools are present when the first prompt is built. Ours pins a server out of deferral and nothing more. That is a connect-timing property of a non-blocking MCP startup rather than a loading one, so it belongs with MCP connection work and not here.`

**Two things deliberately NOT recorded as deviations**, so the omissions are
chosen rather than missed:

- **The per-server control needs no settings surface.** § 5h: `alwaysLoad` is
  already parsed from three declaration sites and honoured end to end. It is a
  server property and it lives with the server, so this slice grows no UI and
  the register carries no row.
- **The result caps and the catalogue ceiling are differences, not absences.**
  Claude returns five tools per search and loads up to five per step
  (`tool-search.md:20,158`) and caps the catalogue at 10,000 (`:157`). We return
  twenty, load an unbounded list, and cap search *output* at 32 KB instead —
  wider on purpose, because without a name listing the search result is the
  model's only view of the catalogue, so a five-row page would cost round-trips
  Claude does not have to spend. If the name listing lands, revisit the twenty.
