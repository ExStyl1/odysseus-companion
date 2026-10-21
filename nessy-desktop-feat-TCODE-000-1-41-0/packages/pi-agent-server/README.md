# Pi Agent Server

`@nessy-agent/pi-agent-server` is the headless Pi-compatible agent subprocess
used by Nessy Desktop. It is initialized over JSONL stdio with an `init` message
and then receives prompt and runtime update messages from the desktop host.

## Package identity (`PI_PACKAGE_DIR`)

Pi resolves its own package directory through `getPackageDir()`, and since
`@earendil-works/pi-coding-agent` 0.84.3 that resolver walks PAST a `dist/package.json`
whose parent also carries one — exactly the identity this package plants for the dev
bundle. Without help the dev spawn reads the workspace's own manifest and refuses the
runtime as `Unsupported Pi runtime 1.0.2; expected 0.87.1`. The host therefore sets
`PI_PACKAGE_DIR` (the resolver's own first branch) to the directory of the spawned
server at the spawn site, for the dev and the packaged layout alike;
`packages/shared/src/agent/__tests__/pi-bundle-package-identity.test.ts` slices the
shipped resolver out of `config.js` and drives it over both layouts, so the next
upstream path rule goes red before anyone launches. (That rule is UNCHANGED at 0.84.4, 0.85.1
and 0.87.1, re-read from the installed `config.js` on 2026-09-13, 2026-09-24 and 2026-10-10 — the guard is
what proves it, because it reads the shipped resolver rather than a copy of it. The
file name in this paragraph was wrong until the same lift: it said
`dev-bundle-identity.test.ts`, which exists nowhere in the tree.)
The same message has two more causes: a stale `dist/` after `rm -rf` without the
package's own `bun run build`, and a stale workspace-nested copy of the Pi packages
shadowing the hoisted root install after a lift — assert provenance from THIS
workspace, never from the repo root.

## Orchestrator Tools

The server registers two custom orchestration tools alongside the builtin Pi
tools, web tools, and host-proxied tools:

| Tool | Purpose |
| --- | --- |
| `subagent` | Runs one child agent, a capped set of parallel child agents, or a sequential chain. |
| `workflow` | Runs a sandboxed JavaScript orchestration script with `agent`, `child`, `parallel`, `pipeline`, `phase`, `log`, `args`, and `budget` injected. |

Child sessions use the same process-local auth storage and model registry as
the parent. Scout, planner, and reviewer agents use the read-only builtin tool
set. Worker agents use the full builtin tool set.

## Init Orchestrator Config

Pass orchestrator defaults on the `init` message under the `orchestrator` key:

```json
{
  "type": "init",
  "model": "tgpt/qwen35-397b-a17b-fp8",
  "orchestrator": {
    "concurrency": 16,
    "depth": 3,
    "maxParallelTasks": 100,
    "maxAgents": 1000,
    "tierModelMap": {
      "small": "small-model-id",
      "medium": "medium-model-id",
      "big": "big-model-id"
    },
    "tokenBudget": 100000
  }
}
```

| Option | Default | Applies to | Notes |
| --- | --- | --- | --- |
| `concurrency` | `16` | `workflow` | Machine-independent ceiling of the workflow child-session semaphore (`workflows.md:322`, "Up to 16 concurrent agents, fewer on machines with limited CPU cores"). The spawner narrows the EFFECTIVE cap to `min(concurrency, cpuCores - 2)`, floored at 1, so a large fan-out cannot starve the host (`cpuCores` from `os.availableParallelism()`). The config value stays deterministic in the execution manifest; only the runtime semaphore is clamped. Since R60 this is the WORKFLOW ceiling only — `sub-agents.md:905` makes the two limits separate, and the `subagent` tool has its own (next row). |
| `depth` | `3` | `subagent`, `workflow` | Maximum child-session depth enforced by the spawner. Default is THREE subagent layers below the main conversation. The host resolves the override from `NESSY_MAX_SUBAGENT_SPAWN_DEPTH` (Claude's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is accepted as a compat alias; the Nessy name wins when both are set): a positive whole number in plain digits, anything else ignored, so the limit can be adjusted but not removed. Set `1` to turn nesting off. Nested spawns stay foreground (only depth-1 top-level spawns default to background), so deeper trees do not change background semantics. |
| _(env only)_ `NESSY_MAX_CONCURRENT_SUBAGENTS` | `20`, narrowed by RAM | `subagent` | The concurrent-subagent ceiling (`sub-agents.md:898`; Claude's `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is a compat alias, the Nessy name wins when both are set). NOT a manifest field — the subprocess reads it, so nothing lands on the hashed execution manifest. A spawn over the ceiling FAILS with `Concurrent subagent limit reached` and is told not to retry; it does not queue. Left at its default the ceiling is narrowed to `hostLiveAgentCeiling - 1` (one agent runtime per 2 GiB of RAM), so 20 is what you observe from ~42 GiB upward, 7 on a 16 GiB laptop — always with the documented message and always naming the number in force. An explicit value wins outright and the host's live-agent ceiling rises to follow it. Exempt: `/subtask` forks (`:902`, counted but never blocked), resumes (`:903`, a fresh slot with no check), workflow and judge children (`:905`), and sessions running at max effort (`:898`, ultracode). **Since P6.16 the knob is not Pi-only.** An EXPLICIT value is also handed to the claude-runtime subprocess (`agent/options.ts` writes the Claude spelling into `buildClaudeSubprocessEnv`), where the SDK's own counter enforces it and prints its own version of the same refusal; before that it was enforced on Pi and silently ignored on claude. The RAM narrowing is deliberately NOT forwarded — it prices a Pi SUBPROCESS, and a claude subagent is a context window inside the one subprocess the session already holds — so with the knob unset claude keeps the documented default of 20 while Pi narrows. Set the knob to get one number on both. |
| _(env only)_ `NESSY_TOOL_OUTPUT_TOKEN_LIMIT` | host `30000` characters | `codex` | **Codex only, and it RAISES rather than lowers.** `models-manager/src/model_info.rs` gives codex's production fallback `truncation_policy: bytes(10_000)`, multiplied by 1.2 in `context_manager/history.rs` — so an unconfigured codex session shows a THIRD of what Pi and claude do. `writeCodexConfig` now emits `tool_output_token_limit`, and `with_config_overrides` converts it back to bytes with `approx_bytes_for_tokens` (`APPROX_BYTES_PER_TOKEN = 4`), so the host's character count round-trips to the number the operator typed (P3.348, W5-b). |
| _(env only)_ `NESSY_MAX_SUBAGENT_SPAWN_DEPTH` on codex | codex's own `1` | `codex` | The depth row above is the HOST's spawner. P3.347 (W5-b) also writes `[agents] max_depth` into codex's own config, so the operator's depth binds inside codex too — the multi-agent backend in force is V1 (measured on the shipped `codex-app-server`: `multi_agent` enabled, `multi_agent_v2` not), where `max_depth` is live. Residue: codex's own defaults are 6 threads / depth 1 against the host's 20 / 3, so an unconfigured codex session nests one level where an unconfigured Pi session nests three. |
| `maxParallelTasks` | `100` | `subagent` | Maximum items accepted by one `subagent` parallel call. Values below 1 fall back to 100. Enforced in the handler and **deliberately absent from the tool schema**: the schema is hashed into a single static model-contract pin, so advertising a per-host `maxItems` made any non-default value kill its own first turn with `Pi execution manifest model contract mismatch for subagent`. The rejection message carries the effective number. |
| `maxAgents` | `1000` | `workflow` | Runaway backstop: maximum `agent()` calls per workflow run. Tool input `maxAgents` can only LOWER this for one run. |
| `tierModelMap` | unset (host-defaulted) | `subagent`, `workflow` | Optional model override by agent tier: `small`, `medium`, or `big`. Missing tiers use the parent `model`. When unset AND the active provider's catalog exposes the Nessy Gateway `fast` alias, the host defaults `small` to that cheap model (see "Tier-Model Default" below); `medium`/`big` stay unset. Explicit config always wins. |
| `tokenBudget` | unset | `workflow` | Shared default token budget per workflow run. Tool input `tokenBudget` overrides it for one run. |
| `contextSeed` | unset | `subagent`, `workflow` | Host-materialized stable prose context (workspace root, project summary) inserted between the safety core and the agent system prompt of every child session. Prose only — it never widens child tool or permission restrictions. Bounded to 16 KB. |
| `sessionDepth` | `0` | `subagent`, `workflow` | This session's own child-session depth (`0` = top-level). Drives the background default and the depth passed to nested spawns. |

## Tier-Model Default

Every subagent runs on a model resolved by this precedence (highest wins):

1. **Per-call `model`** — the `model` argument on a `subagent`/`workflow`
   `agent()` call (unless `inherit`).
2. **Per-agent `model` frontmatter** — an explicit `model:` in the agent
   definition (unless `inherit`).
3. **`tierModelMap[tier]`** — the tier map for the agent's `tier`
   (`small`/`medium`/`big`).
4. **Session `model`** — the parent session's model.

`tierModelMap` ships unset, so historically every tier inherited the session
model and read-only small-tier scouts burned the flagship. The host now seeds a
default: when `tierModelMap` is NOT explicitly configured AND the active
provider's model catalog exposes the Nessy Gateway `fast` alias (resolved by the
alias, not a pinned id — the underlying id rotates and the catalog auto-refreshes
via `model-fetchers/nestor.ts`), `small` defaults to that cheap `fast` model.
`medium` and `big` stay unset (session model). Built-in `scout` (tier `small`)
therefore runs on the cheap model, while `planner`/`reviewer` (medium) and
`worker` (big) stay on the session model. Providers without a `fast`-class alias
keep today's behavior exactly, and any explicit workspace/user `tierModelMap`
always wins.

## Background Default

Top-level `subagent` calls (`sessionDepth` 0) default to background: the tool
returns `task_id` and `agent_ids` immediately and the result arrives
asynchronously (`task_completed` event, `get_subagent_result`, `stopTask`).
Nested child sessions default to foreground. An explicit `background: false`
(or `true`) call argument always wins. The spawner applies the same default
(`background ?? (depth === 1)`) and still awaits `monitor` for background
children, so `workflow` `agent()` calls always return completed results to the
script.

Limitation: parent→child prompt-cache token sharing is NOT shipped. Child Pi
sessions are separate processes and separate conversations, so the parent's
cached prompt prefix cannot be reused by children; `contextSeed` is an explicit
prose seed, not a cache handle. No surveyed Pi package implements cross-process
prompt-cache sharing either.

`subagent` parallel mode has its own configurable per-call cap. `workflow`
journals completed `agent()` calls under `<sessionPath>/.orchestrator/` and can
replay cached child results when called with `resumeRunId`. Prefer `agent()` in
new scripts; `child()` is accepted as a compatibility alias with identical
runtime behavior.

Example workflow script:

```js
phase('inspect');
const scout = await agent({ agent: 'scout', task: 'Inspect the workspace.' });
phase('review');
const reviews = await parallel([
  () => agent({ agent: 'reviewer', task: `Review: ${scout}` }),
  () => agent({ agent: 'planner', task: 'Plan follow-up work.' }),
]);
return reviews.filter(Boolean);
```

Workflow helper failure semantics match Claude Code orchestration scripts:
`parallel()` settles every thunk and returns `null` for failed entries instead
of rejecting the whole run. `pipeline()` processes items independently; if one
stage throws for an item, only that item becomes `null`. Downstream scripts
should use `filter(Boolean)` before consuming only successful outputs. The
workflow result details include per-index failure metadata for `parallel()` and
`pipeline()` null entries.

## Workflow Sandbox

Workflow scripts are parsed with `acorn` before execution. The sandbox rejects
imports, dynamic imports, `require`, `process`, `globalThis`, `eval`,
`Function`, `this`, `import.meta`, `new.target`, and constructor/prototype escape
paths before running the script with `new Function` and the injected API only.

## Agent Definitions

Built-in agent definitions are `scout`, `planner`, `worker`, and `reviewer`.
When `workspaceRootPath` points at a reachable workspace, the loader also reads
optional `orchestratorAgents` entries from `<workspaceRootPath>/config.json` and
markdown agent files (frontmatter + system-prompt body) from the workspace and
trusted-project `agents/` directories. Custom entries replace built-ins with the
same name.

### Definition schema

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string (required) | — | Unique agent name; markdown filename is the fallback. |
| `systemPrompt` | string (required) | — | Agent instructions (the markdown body). |
| `description` | string | generated | Short human summary. |
| `toolset` | `read-only` \| `full` | `read-only` | Invalid values warn-and-ignore to the default. |
| `tools` | string[] | derived from `toolset` | Explicit tool allowlist. |
| `tier` | `small` \| `medium` \| `big` | `medium` | Selects `tierModelMap` model when set. |
| `model` | string | inherit session model | Explicit per-agent model override. |
| `disallowedTools` | string[] | — | Patterns removed from the effective tool set. |
| `maxTurns` | positive int | unbounded | Upper bound on the child's model round trips PER RUN (the start and each resume are runs). Invalid/non-positive/non-integer values warn-and-ignore to unbounded. |
| `permissionMode` | mode key/alias | inherit parent | Requested permission mode for the child. Invalid values warn-and-ignore to inheriting the parent. |

### `maxTurns` and `permissionMode` semantics

Both fields are host-enforced restrictions carried on the spawned child, and
both only ever NARROW — they never widen the parent's authority:

- **`maxTurns`** bounds the child's own agentic loop: each run (the spawn, and
  every `resume`) gets at most that many model round trips (F1.83), and a capped
  child can be resumed to continue, as `sub-agents.md` specifies (F1.224). When
  the spawning session is itself a bounded child, the requested bound clamps
  down to the inherited one (`min`). Absent on the def means unbounded by this field.
- **`permissionMode`** is CLAMPED to be no broader than the parent session's
  mode before the child session is created. The canonical strictness ordering is
  `dontAsk < plan < default < acceptEdits < auto < bypassPermissions`
  (`PERMISSION_MODE_ORDER` in `packages/shared/src/agent/mode-types.ts`; the retired
  `explore` and the spellings `safe`/`ask`/`allow-all` this line used to give are permanent
  read-path aliases, not what the clamp compares); a broader request clamps
  down to the parent, a stricter request is honored as-is. Absent on the def
  means the child inherits the parent's mode verbatim (unchanged behavior).
  Tool-level permission enforcement remains the sole authority — this only sets
  the mode the child starts in.

  **This is narrower than Claude's documented rule, deliberately (P6.496).**
  `agent-sdk/permissions.md#available-modes` says: *"Subagents inherit the parent
  session's permission mode. An `AgentDefinition`'s `permissionMode` can override
  it, except when the parent uses `bypassPermissions`, `acceptEdits`, or `auto`:
  those modes apply to every subagent and can't be overridden per subagent."*
  Upstream therefore DISCARDS your declared mode under those three parents —
  including one that asks for LESS authority than the parent has. We keep it: a
  definition declaring `permissionMode: plan` under a `bypassPermissions` parent
  runs in `plan` here and would run in `bypassPermissions` upstream.

  The deviation only ever narrows, which is why it stands: matching the page
  would take a definition that asked for less and hand it more, on the three
  broadest parents there are, and the page's own next paragraph says what that
  costs — *"Subagents may have different system prompts and less constrained
  behavior than your main agent, so inheriting `bypassPermissions` grants them
  full, autonomous system access."* It is one host-side mechanism shared by all
  three runtimes, so a definition behaves the same way on Pi, claude and codex.
  Pinned by `packages/shared/src/agent/__tests__/permission-mode-clamp.test.ts`
  (§P6.496) so it cannot be "fixed" back into alignment by accident.

## Smoke Gate

The live gateway smoke runner is committed at
`packages/pi-agent-server/scripts/smoke-orchestrator.ts`. It reads credentials
from `NESSY_GATEWAY_JWT`, `NESTOR_JWT`, or `~/.nessy/dp_auth_creds.json` at
runtime. The credentials file is shared with `nessy-cli` and must remain
read-only to this package.

### `check:surface -- --pin` takes minutes and can refuse

`bun run check:surface -- --pin` re-pins the source-state digest, and since P6.1077 (2026-09-11)
it first recomputes the model-facing declaration hash the production way and REFUSES — exit 1,
naming the tool and both hashes, with the remedy printed — when that hash no longer matches
`PI_STATIC_MODEL_CONTRACT_HASHES`. That is the guard for the day a tool's model-visible
description changes and only half of its contract is re-pinned (how `d0e61e7ff` shipped a Pi
`review` that died on every first turn; P6.1079). Budget minutes for the run: it imports the
tool graph.
