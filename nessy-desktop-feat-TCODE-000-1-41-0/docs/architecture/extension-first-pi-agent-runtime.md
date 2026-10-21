# Extension-first Pi agent runtime

## Qualified runtime

Nessy Desktop ships the Pi-compatible runtime as a closed, host-composed
subprocess. The pinned bill of materials is Pi `0.84.0` from upstream tag
`v0.84.0`, package gitHead `8199aca40c9cf27aff3de7ba852e420985a54bf5`, under MIT,
with Node `>=22.19.0`. The packages are resolved through the approved Artifactory
npm proxy and pinned by `bun.lock`.

**0.84 split the family from four packages to seven.** `pi-coding-agent` gained
`pi-client` and `pi-protocol` alongside `pi-tui`, and both `pi-ai` and
`pi-agent-core` gained `pi-telemetry`. Only the first three are direct
dependencies of our manifests; the rest arrive transitively and are pinned by
the lock, which `package-manifest.test.ts` asserts resolves the whole family to
one approved version.

| Package | Integrity |
| --- | --- |
| `@earendil-works/pi-ai@0.84.0` | `sha512-N9RDk8q0eglGiy+NqTZ3Ev2j+6oFNXSAJa8b0CYhvWB9HGiKZjsoCESXkUvMDLybrn0wXp75sdsoBzEtHxk9kA==` |
| `@earendil-works/pi-agent-core@0.84.0` | `sha512-L1lw0lwR5LXCzGEeHD9XNEruU2bg0H8clOA8ySdGMHvxutp8GC+yZL6MZp4tqQRnLKP3gHmY7TrWzQ3YnFdJYQ==` |
| `@earendil-works/pi-coding-agent@0.84.0` | `sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==` |
| `@earendil-works/pi-client@0.84.0` | `sha512-fHXgw1FdLDh+uw42SvTkJRBfgc3nsrslghvbRFEAxdjfcOxJt7hPsTj4HHNK96wMy1f+zvQYL8Y2znvFoZ8JDA==` |
| `@earendil-works/pi-protocol@0.84.0` | `sha512-Fc28cCYGg5+aRnMzbAD7QAi6Xl//kbETyFroLHCs3Zf4oaXH9L2gzBqVLVAwrKIKeS0uffUrmihocGTECfKW6Q==` |
| `@earendil-works/pi-telemetry@0.84.0` | `sha512-g6hLxEfAUk3zJlDmFWhWHJNcYXYiNGeWuJC9YkcHpkdkj0gxD4uaMNNNU3QsAEJXW9Qcxnl21+U8GfhVsc8C5g==` |
| `@earendil-works/pi-tui@0.84.0` | `sha512-nbs0FeZJ5rWDD6VpKfXXmYbEHnHqb40V9glE2l9f8ftoWpsP8nw0WcXK8jOjfRsDPnT9dJHy3dItOHdn/AFGjA==` |

**Model runtime and credentials are process-local, and offline by
construction.** 0.84 replaced `AuthStorage` + `ModelRegistry.inMemory()` with one
async `ModelRuntime`, whose `create()` otherwise reads the GLOBAL
`~/.pi/agent/models.json` and `auth.json` and wraps every built-in provider in a
`pi.dev` catalog fetcher. `PiRuntimeAdapter` therefore always passes
`modelsPath: null`, an in-memory `CredentialStore` (so `authPath` is never
consulted), and leaves `allowModelNetwork` at its `false` default — and sets
`PI_OFFLINE` before the first `create()`, because `ModelRuntime.refresh()`
defaults `allowNetwork` to the runtime's own flag, so an extension calling
`modelRegistry.refresh()` with no argument would otherwise reach pi.dev. Both
halves are required; neither alone is sufficient.

The runtime loads only source-controlled built-ins from the closed extension
registry. It does not scan or install ambient extensions, skills, prompts, or
`node_modules`. Electron packages the compiled runtime at
`resources/pi-agent-server/index.js` and the session MCP server at
`resources/session-mcp-server/index.js`; their build inputs are
`packages/pi-agent-server/dist/index.js`, `scripts/electron-build-main.ts`, and
`scripts/stage-electron-servers.ts`.

## Authority map

There is one owner for each durable or effectful responsibility:

| Responsibility | Current authority |
| --- | --- |
| Capability selection | Effective capability snapshot/runtime view and its materializer |
| Tool identity and presentation | Versioned harness descriptors, bindings, and finalized manifest |
| Pi session construction | `PiAgent` host init, JSONL protocol, and the closed runtime adapter |
| Tool execution | Shared `ToolExecutor`; Pi wrappers are presentation adapters only |
| Permission and approval | Server `PermissionService`, strict receipt, and one child consumption point |
| Process and isolation | `ProcessSupervisor` plus the X4A isolation selector |
| Tasks and interaction | `TaskService`, `AskUserService`, and `PlanModeService` composed by `SessionManager` |
| Child orchestration | `ChildSessionService`, `MailboxService`, and `WorktreeLeaseService` |
| MCP and LSP | One MCP pool and one session-owned supervised LSP service |
| Context and resources | Effective capability materializer and curated immutable resource loader |
| Checkpoint and rewind | Existing file-checkpoint manifest/serializer with explicit rewind limits |
| Lifecycle and hooks | Built-in lifecycle bridge into the existing automation event sink |
| Persistence and recovery | `SessionManager` and the existing session store/replay owners |
| Desktop projection | Typed snapshot/control RPC, sequenced invalidation, and the surfaces that read them (the agent panel below the composer, the unified MCP servers panel) |
| Provider dialects | Pi/Qwen and Nestor A2A adapters around unchanged public provider envelopes |

The finalized manifest, prompt metadata, registered SDK tools, executor ports,
and permission receipt share the same semantic and binding identities. The host
fails before spawning Pi when that finalized capability runtime is absent.
There is no standalone manifest ingress, fallback runtime, second resolver,
second scheduler, or shadow permission path.

## Qualified behavior

- Tools route through descriptor/binding projection, `ToolExecutor`, permission
  receipt, scheduling, isolation, and dispatch. Deferred MCP tools are activated
  in the same session only when their exact current-manifest binding is loaded.
- MCP calls preserve structured results, caller cancellation, bounded configured
  secret redaction, immutable resources/prompts, and per-source health. LSP is
  advertised only for a trusted project after a successful initialize handshake.
- Task DAG, AskUser, and plan state are versioned, session-bound, transactional,
  durable, and reprojected by their server owners. Headless approval fails closed.
- Foreground/background child sessions, steering, result lookup, stop, mailbox,
  budgets, and worktree leases remain distinct durable identities. Real OS jobs
  stay under `ProcessSupervisor`; dirty worktrees are never reset or removed.
- Checkpoint restore reports file existence, mode, partial effects, and the
  irreversible shell/network/database boundary rather than claiming a general
  rollback.
- Compaction reinjects bounded task, plan, permission, and resource references,
  not secret-bearing content, actions, or lost promises.
- The Desktop reads a detached server snapshot, then uses sequenced invalidation
  only to coalesce refetches. It projects diagnostics and existing controls
  without becoming a second state, cursor, process, task, or checkpoint owner.
- Session provider/agent selection remains immutable. Claude, Codex runtime, and
  Nestor production behavior is unchanged by the Pi runtime cutover.

## Measured parity

The final 48-case corpus has 46 implemented cases, no partial cases, no missing
or blocked cases, and 2 accepted provider differences. Its canonical weighted
score is **190/192 (98.96%) implemented** and **192/192 (100%) accepted
contract**, including accepted differences.

The three previously deliberate partials are now closed:

- `workflow-evaluator`: workflow script evaluation is bounded **in-process** by
  the sandbox evaluator, **not** by the X4A ProcessSupervisor. Moving evaluation to
  a supervised external process is architecturally infeasible: the workflow DSL
  (`agent()`, `workflow()`, `parallel()`, `pipeline()`, `log()`, `budget`) are live
  synchronous callbacks into the parent Pi runtime's object graph (journal, child
  spawner, progress state), so evaluation cannot cross a process boundary without
  rewriting the hash-pinned `createWorkflowTool`. Instead, `compileWorkflowScript`
  source-transform-instruments the compiled function: a wall-clock
  synchronous-slice guard is injected at **every loop back-edge** (block, single-
  statement, and empty-statement bodies are all normalized to a guarded block) and
  at every function body (bounding recursion), reset on each `await` resumption,
  plus a bounded `log()` output accumulator. A runaway synchronous loop, unbounded
  recursion, or oversized output aborts with `WorkflowEvaluationLimitError` instead
  of blocking the Pi subprocess event loop. The `workflow.execute` model contract
  (a source hash of `createWorkflowTool`) is unchanged.
  Residual limitation (accepted): the guard bounds control-flow back-edges it can
  instrument. A single synchronous built-in call with no back-edge — e.g.
  catastrophic-backtracking regex evaluation or one giant allocation — is not
  interruptible by the source transform and remains a theoretical way to stall the
  slice between guard points. The token budget and async yielding still bound all
  spawned child-agent work; only pathological single-expression synchronous blocking
  is out of the transform's reach.
- `hooks-semantics`: `CwdChanged`, `FileChanged`, `PostCompact`, `McpElicitation`,
  and `McpResult` now have a frozen observable contract
  (`PI_LIFECYCLE_HOOK_CONTRACTS`) declaring each hook's owner, decision-vs-
  observational class, ordering and terminal-delivery guarantee. At the time
  that contract was frozen, four of the five were observational and only
  `PreToolUse` and `PermissionRequest` were decision-bearing.

  **That sentence no longer describes the tree.** The authority is
  `AGENT_EVENT_CONTRACTS_V1` in `packages/shared/src/automations/types.ts`, and
  it now marks **six** events `kind: 'decision'`: `PreToolUse`,
  `PermissionRequest`, `TaskCreated`, `TaskCompleted`, `McpElicitation` and
  `ElicitationResult`. `McpElicitation` is one of the five named just above, so
  the "five observational events" reading is wrong for it specifically —
  `CwdChanged`, `FileChanged`, `PostCompact` and `McpResult` are still
  observational. `TaskCreated` is decision-bearing in the strong sense: exit 2
  rolls the task creation back. Separately, `UserPromptSubmit` and
  `UserPromptExpansion` are observational in the contract table but are gated
  through `PI_PROMPT_GATE_EVENTS` (`pi-agent.ts:409`), a fail-closed prompt gate
  where a block is always terminal for the turn. Read the constant, not this
  paragraph, before asserting what can block.
- `hooks-complete-inventory`: those same five events are now canonical members of
  the shared event/bridge inventory (`AgentEvent`, `AGENT_EVENTS`,
  `SdkAutomationInput`, `EventPayloadMap`) and are emitted observationally through
  the single existing lifecycle-bridge sink — no second hook dispatcher appears.
- `plugin-hook-type-runtimes` (1.4.0): the four non-command plugin hook types run
  through the same single hook executor and owners, never a new dispatcher. A
  `prompt` hook injects a one-shot observational `additionalContext` overlay on
  its bound event through the existing decision path (never decision-bearing on
  its own); an `agent` hook spawns through the existing per-session child-session
  service via an injected runner (no new spawn authority); an `mcp_tool` hook
  invokes a fully-qualified `mcp__<server>__<tool>` proxy through the existing MCP
  pool; an `http` hook fires through the existing webhook executor (bounded
  timeout + response cap) only under a fail-closed network permission grant. All
  are trust-gated through the existing `CapabilityTrustStore`. Hook *type* is
  never what makes a hook decision-bearing — that is the event's own contract
  row in `AGENT_EVENT_CONTRACTS_V1`, six of which are `kind: 'decision'`; see
  the correction under `hooks-semantics` above.

`provider-pi-qwen-dialect` and `provider-nestor-a2a-dialect` remain
accepted-difference cases: their wire syntax differs while semantic identity,
permission, execution, cancellation, and public A2A behavior remain bounded.

> **The line ledger below is a QUALIFICATION-TIME SNAPSHOT, not a description
> of the current tree.** It is retained because the deltas and hashes are the
> evidence the extension-first route was qualified on; it is not maintained.
> Every row has drifted since. Spot-checked 2026-07-30:
> `packages/shared/src/agent/pi-agent.ts` is 7,623 lines against the ledger's
> 4,574; `packages/pi-agent-server/src/index.ts` 4,411 against 3,087;
> `packages/server-core/src/pi-harness/isolation.ts` 379 against 43; and of the
> "two zero rows", `orchestrator/background-task-registry.ts` is now 182 lines
> while `session-tool-prompt.ts` no longer exists. Measure the tree if you need
> a current number; read this for the qualification argument only.

The X0 frozen baseline measured 45 production files, 15,399 physical lines,
and 15 responsibility rows; its ledger hash was
`6d34de8c9b404e145e1806dc3c1c382acbfed9754b12fbdd613e7c91d37d0ed4`.
Repeating the exact frozen 45-path measurement at qualification gives 43
surviving files, **15,543 physical lines**, a **+144 line** delta, and ledger
SHA-256
`7d6c84620699a71278276de0ec05ca3598aecf00423344b81bb3e46bdb7bcc80`.
The two zero rows are `background-task-registry.ts` and
`session-tool-prompt.ts`.

That frozen comparison alone omits moved code. The expanded attributed ledger
therefore adds production owner paths created or selected by the accepted
harness route, including its required project Q0 owner, for responsibilities
moved out of the frozen paths. It excludes tests, fixtures, generated code,
docs, licenses, vendored dependencies, and unrelated pre-existing owner paths.
Using the same sorted `path<TAB>PLOC` and zero-for-delete method, the expanded
ledger has 83 rows, 81 present production files, and **20,468 physical lines**,
a **+5,069 line** delta; its SHA-256 is
`80ea7a46148317f7532c9d11bb004f584728f6f0a87543c9bbcf539791caa866`.

Exact expanded ledger (`path<TAB>PLOC`, sorted):

```text
apps/electron/src/renderer/components/right-sidebar/PiRuntimeControlCenter.tsx	175
packages/core/src/types/pi-harness-runtime.ts	184
packages/pi-agent-server/src/ambient.d.ts	6
packages/pi-agent-server/src/compat/pi-legacy-ingress.ts	49
packages/pi-agent-server/src/compat/pi-runtime-adapter.ts	378
packages/pi-agent-server/src/context-usage.ts	96
packages/pi-agent-server/src/custom-endpoint-models.ts	69
packages/pi-agent-server/src/deferred-mcp-tools.ts	161
packages/pi-agent-server/src/extensions/deferred-mcp-extension.ts	60
packages/pi-agent-server/src/extensions/descriptor.ts	62
packages/pi-agent-server/src/extensions/guard.ts	137
packages/pi-agent-server/src/extensions/lifecycle-bridge.ts	40
packages/pi-agent-server/src/extensions/registry.ts	150
packages/pi-agent-server/src/extensions/resource-loader.ts	132
packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts	380
packages/pi-agent-server/src/gateway-proxy/tool-schema-dialect.ts	78
packages/pi-agent-server/src/harness/tool-manifest.ts	320
packages/pi-agent-server/src/index.ts	3087
packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts	663
packages/pi-agent-server/src/local-tools/tool-wrapper.ts	237
packages/pi-agent-server/src/model-resolution.ts	89
packages/pi-agent-server/src/nessy-metadata-schema.ts	68
packages/pi-agent-server/src/orchestrator/agent-defs.ts	10
packages/pi-agent-server/src/orchestrator/ask-user-tool.ts	165
packages/pi-agent-server/src/orchestrator/background-task-registry.ts	0
packages/pi-agent-server/src/orchestrator/journal.ts	62
packages/pi-agent-server/src/orchestrator/sandbox.ts	123
packages/pi-agent-server/src/orchestrator/spawner.ts	210
packages/pi-agent-server/src/orchestrator/subagent-e2e-preload.ts	53
packages/pi-agent-server/src/orchestrator/subagent-tool.ts	577
packages/pi-agent-server/src/orchestrator/workflow-recipes.ts	30
packages/pi-agent-server/src/orchestrator/workflow-tool.ts	627
packages/pi-agent-server/src/pick-mini-model.ts	35
packages/pi-agent-server/src/pretool-context.ts	25
packages/pi-agent-server/src/proxy-tool-result.ts	38
packages/pi-agent-server/src/session-tool-prompt.ts	0
packages/pi-agent-server/src/system-prompt-override.ts	11
packages/pi-agent-server/src/tools/background-bash.ts	58
packages/pi-agent-server/src/tools/notebook.ts	218
packages/pi-agent-server/src/tools/search/create-search-tool.ts	114
packages/pi-agent-server/src/tools/search/providers/chatgpt.ts	223
packages/pi-agent-server/src/tools/search/providers/ddg.ts	228
packages/pi-agent-server/src/tools/search/providers/google.ts	84
packages/pi-agent-server/src/tools/search/providers/openai.ts	72
packages/pi-agent-server/src/tools/search/providers/responses-api-parser.ts	122
packages/pi-agent-server/src/tools/search/resolve-provider.ts	94
packages/pi-agent-server/src/tools/search/types.ts	12
packages/pi-agent-server/src/tools/web-fetch.ts	419
packages/server-core/src/pi-harness/ask-user-service.ts	107
packages/server-core/src/pi-harness/child-session-service.ts	393
packages/server-core/src/pi-harness/isolation.ts	43
packages/server-core/src/pi-harness/isolation/darwin.ts	24
packages/server-core/src/pi-harness/isolation/linux.ts	33
packages/server-core/src/pi-harness/isolation/windows.ts	5
packages/server-core/src/pi-harness/lsp-service.ts	258
packages/server-core/src/pi-harness/mailbox-service.ts	38
packages/server-core/src/pi-harness/permission-service.ts	106
packages/server-core/src/pi-harness/plan-mode-service.ts	128
packages/server-core/src/pi-harness/process-store.ts	133
packages/server-core/src/pi-harness/process-supervisor.ts	322
packages/server-core/src/pi-harness/task-service.ts	26
packages/server-core/src/pi-harness/workspace-drain-participant.ts	236
packages/server-core/src/pi-harness/worktree-lease-service.ts	157
packages/server-core/src/workspaces/workspace-quiescence.ts	207
packages/session-tools-core/src/handlers/task.ts	11
packages/shared/src/agent/backend/pi/constants.ts	22
packages/shared/src/agent/backend/pi/event-adapter.ts	1107
packages/shared/src/agent/backend/pi/index.ts	13
packages/shared/src/agent/backend/pi/session-tool-defs.ts	25
packages/shared/src/agent/pi-agent.ts	4574
packages/shared/src/agent/pi-harness/agent-harness-capabilities.ts	286
packages/shared/src/agent/pi-harness/child-session-port.ts	152
packages/shared/src/agent/pi-harness/context-resource.ts	95
packages/shared/src/agent/pi-harness/execution-receipt.ts	102
packages/shared/src/agent/pi-harness/harness-manifest.ts	381
packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts	257
packages/shared/src/agent/pi-harness/lsp-port.ts	61
packages/shared/src/agent/pi-harness/permission-receipt.ts	209
packages/shared/src/agent/pi-harness/process-supervisor-port.ts	36
packages/shared/src/agent/pi-harness/prompt-composer.ts	45
packages/shared/src/agent/pi-harness/tool-executor.ts	393
packages/shared/src/agent/pi-harness/tool-scheduler.ts	85
packages/shared/src/protocol/pi-harness-runtime.ts	167
```

The increase is explicit: authority moved out of the large Pi process into
typed shared/server/Desktop owners while the responsibility count remains the
15 rows above. X2-X11 reduced duplicate authority, not total physical LOC.

## Agent parity follow-up contracts

The releases 1.2.0–1.5.0 plugin work is followed by four low-risk Claude-Code /
qwen-code parity contracts. Each extends an existing owner from the authority
map; none adds a second store, dispatcher, or process authority.

- **Marked auto-memory + scheduled cleanup.** The `remember` session tool now
  appends agent-written entries with a stable machine marker
  (`<!-- nessy:auto:<date> -->`). Unmarked lines are treated as human-authored
  and are never rewritten. The marker is stripped at load *before*
  `mergeMemoryContents` dedup — so a marked and unmarked duplicate still
  collapse — and never reaches the prompt block. A bounded, idempotent cleanup
  pass (`agent/memory/memory-cleanup.ts`) collapses near-duplicate marked
  entries and expires marked entries past a threshold; it excludes all unmarked
  content unconditionally, leaving it byte-identical after a pass. The trigger
  is a direct `SchedulerTick` subscriber inside `AutomationSystem` (the scheduler
  already wired there), daily-throttled by a persisted last-run stamp; on failure
  it logs and no-ops and never blocks a turn. `memory-store` and
  `AutomationSystem` remain the only memory owners.

- **Hook decision loop-safety.** The host-side pre-tool decision path
  (`pi-agent.ts` `handlePreToolUseRequest`) keeps a per-turn counter of repeated
  block/deny decisions keyed by (hook, tool, canonical input), cleared at the
  turn boundary (`startTurn`). Past a threshold (default 3) the deny reason gains
  one bounded final-notice reminder; on the next repeat the turn is stopped
  through the existing stop path with a visible diagnostic — never a silent hang.
  A per-tool total-deny backstop caps dynamically-worded denies that never repeat
  the same reason. The counter lives host-side only (the re-feed loop runs inside
  the SDK subprocess; only the host reply is controllable), never on
  `ManagedSession`, and never counts centralized-gate blocks.

- **Subagent background-default + explicit context seed.** Top-level
  single/parallel/chain spawns default to background (`args.background ??
  (depth === 1)`) and return a task id immediately; nested spawns stay
  foreground; an explicit `background:false` call argument always wins; resume
  always runs inline and returns the resumed result directly (no task id). The
  additive `orchestrator.contextSeed` and `orchestrator.sessionDepth` manifest
  fields carry a host-materialized stable prose block (workspace identity, root,
  working directory) and this session's depth to the subprocess. The spawner
  composes the child prompt as safety-core + contextSeed + agent prompt. The seed
  is flattened to one line per fact (control characters stripped, whitespace
  collapsed) so a newline-bearing workspace name cannot inject prompt lines, and
  is bounded to 16KB. It is prose context only — it never widens a child's tool
  or permission restrictions. Both new fields default to omitted so legacy
  manifests keep their canonical hash. Parent→child prompt-cache token sharing is
  **not** shipped (child sessions are separate processes/conversations). The
  spawner and `ChildSessionService` remain the only spawn owners.

- **LSP breadth.** `LspService` / `PiLspPort` / `PI_LSP_INPUT_SCHEMA` gain the
  request ops `formatting` (`textDocument/formatting`), `range_formatting`
  (`textDocument/rangeFormatting`), and `code_action` (`textDocument/codeAction`);
  the single generic `lsp` tool handler dispatches them with no handler change,
  under the same trusted-project provisioning gate. `consumeFrames` branches on
  method-bearing id-less frames before the id check so a pushed
  `textDocument/publishDiagnostics` notification reaches an optional
  `onDiagnostics` callback and a bounded (256-file) per-URI server-side buffer,
  surfaced through the existing pull `diagnostics` op as `{ pulled, pushed }`;
  `code_action` seeds its context with only range-overlapping buffered
  diagnostics. Unknown notifications are still dropped and request/response
  correlation is untouched. Scope stays protocol-level: no formatter registry,
  no ast-grep/tree-sitter. `LspService` / `PiLspPort` remain the only LSP owner.

The pattern-reference-only provenance for these contracts (`pi-hermes-memory`,
`@tintinweb/pi-subagents`, `pi-lens`) was recorded in
`pi-extension-adoption-scorecard.md`, deleted in `97f7e7af`; recover it with
`git show 97f7e7af^:docs/architecture/pi-extension-adoption-scorecard.md`. The
three names above are the whole of what it carried for this section: no source
was vendored and no npm dependency was added.

## Prompt and review parity contracts (1.7.0)

The 1.7.0 prompt/agent parity work adopts the highest-value Codex base-prompt
and Claude-Code agent-schema patterns where Nessy was behind. Each contract
extends an existing owner; none adds a second decision authority, spawn owner,
or compaction lifecycle. The verbatim-text adoptions and their Apache-2.0
provenance were recorded in `pi-extension-adoption-scorecard.md`, deleted in
`97f7e7af`; recover it with
`git show 97f7e7af^:docs/architecture/pi-extension-adoption-scorecard.md`.

- **`/review` command flow.** `review` is a child-session tool
  (`packages/pi-agent-server/src/orchestrator/review-tool.ts` `createReviewTool`,
  registered in `buildSessionDefinition` beside `subagent`/`workflow`). The host
  computes the diff with read-only git for the requested target — uncommitted
  (staged + unstaged + untracked, the default), against a base ref (merge-base),
  or a single commit — validates the ref inputs against argument injection, and
  embeds the diff in the child task; the reviewer child is never given
  shell/git. It spawns the existing built-in `reviewer` def (read-only toolset:
  `read`/`grep`/`find`/`ls`) with `REVIEW_RUBRIC_PROMPT` substituted as its
  system prompt, runs inline (`background: false`), and returns structured
  findings through the SAME structured-output mechanism `subagent`/`workflow`
  use (`REVIEW_FINDINGS_SCHEMA` → `parseSchemaResult`, one retry on a malformed
  result, no ad-hoc JSON parser). Findings render in the parent result ordered
  most-severe-first (P0 before P3) with `file:line` references; an empty diff
  short-circuits to "patch is correct". No second review thread; the existing
  orchestrator child-session service remains the only spawn owner.

- **Compaction handoff prompt — MANUAL `/compact` only.**
  `COMPACTION_HANDOFF_PROMPT` (`packages/shared/src/prompts/compaction.ts`) is a
  context-checkpoint handoff summary (progress + key decisions,
  constraints/preferences, remaining next steps, critical data/refs; summary
  only, no tool calls) followed by `COMPACTION_HANDOFF_MARKER`, which frames the
  produced summary as a prior-model handoff rather than user input. It is wired
  as the always-leading base of `composePiCompactionInstructions`
  (`agent/pi-harness/prompt-composer.ts`), which the Pi backend's single
  compaction owner (`PiAgent.requestCompact` → `handle.compact()` →
  `session.compact()`) already feeds; explicit `/compact <text>` instructions
  (capped at 8 KB with a `… [truncated]` marker) and the bounded
  reference-reinjection layer after it. **Scope is manual `/compact` only:**
  SDK-owned auto-compaction (threshold + overflow) hardcodes
  `customInstructions: undefined` and only honors a full `{compaction}`
  replacement (not a `{customInstructions}` injection) on
  `session_before_compact`, so it keeps the SDK's own built-in checkpoint
  summarizer — a recorded limitation, not a wiring gap (a full re-own would need
  SDK-private stream/auth and collide with the overflow AbortController flow).
  The Claude backend forwards `/compact` as a raw prompt to its native
  subprocess with no host seam, so it is out of scope by design. No second
  lifecycle owner — only the instructions string the existing owner already
  passed is shaped.

- **Prompt composition split — static Working Effectively + volatile
  modeGuidance.** The prompt pack adds cache-stable guidance to
  `getNessyAssistantPrompt` under `## Working Effectively`: tool-call preambles,
  the review-mindset trigger (findings-first, severity order, `file:line` refs;
  the "prefer the `review` tool" sentence gates to the Pi backend only, which is
  the one that registers the tool), and final-answer formatting. Mode-dependent
  guidance — autonomy/persistence for execute/auto/acceptEdits and the plan
  persona for plan mode — never enters the static prompt; it is emitted through
  the volatile `formatSessionState` `modeGuidance` line (`agent/mode-manager.ts`
  `formatModeGuidance`), exactly one coherent line per active mode. The static
  `## Permission Modes` section replaces the former six-mode table with one-line
  awareness that the modes form a spectrum (least → most permissive), that the
  user can switch at any time, and that the active mode's freely/approval/blocked
  facts live in `<session_state>` under `modeGuidance`. The static prompt stays
  byte-identical per config across turns and across mode switches; both backends
  read `getNessyAssistantPrompt`.

- **Agent frontmatter `maxTurns` + `permissionMode` with a lifetime ceiling.**
  `parseAgentDefinition` (`packages/shared/src/agents/definitions.ts`) accepts
  optional `maxTurns` (positive integer, frontmatter strings coerced) and
  `permissionMode` (resolved through `parsePermissionMode` so canonical names and
  aliases like `explore` map to internal keys); invalid values warn and fall open
  to `undefined`. Both thread onto `PiChildRestrictionsV1` (additive,
  omit-when-default) via the spawner. Host enforcement, all narrow-only: (a)
  `ChildSessionService` tracks `turnsUsed` (start = turn 1, each resume +1) and
  rejects a resume past `maxTurns`; (b) `startPiChildRuntime` clamps the requested
  `permissionMode` against the parent's via `clampPermissionModeToParent`
  (`agent/mode-types.ts`) before `createSession`; and (c) the child-session port
  wrapper additionally narrows both against any inherited child ceiling (`min` for
  maxTurns, clamp for mode). `permissionMode` can only ever NARROW a child's
  effective permissions — the clamp resolves the incomparable safe/plan write-axis
  pair toward the write-safe parent so a child never gains a write capability its
  parent lacks. Per-agent/per-call explicit `model` frontmatter still wins over
  the tier-model default (`resolveAgentModelId` precedence unchanged).

- **Orchestrator defaults — Claude-Code-class limits + tier-model default.**
  `DEFAULT_PI_ORCHESTRATOR_CONFIG` (`agent/pi-harness/harness-manifest.ts`) is
  raised to `{concurrency: 16, depth: 5, maxParallelTasks: 100, maxAgents: 1000}`
  — a machine-independent ceiling. The OS-dependent narrowing lives in the
  subprocess (`spawner.ts` `computeEffectiveConcurrency` =
  `max(1, min(ceiling, cpuCores − 2))`, cores from `os.availableParallelism()`),
  so the manifest config stays deterministic. `maxParallelTasks` is
  contract-visible (it derives the subagent tool's `tasks.maxItems`), so the
  pinned `subagent` model-contract hash was refreshed honestly through the real
  projection. Explicit init/config values still win over the raised defaults;
  throttling degrades gracefully (429-only retry with bounded backoff, each child
  resolves independently — a permanently throttled child becomes an error result
  without aborting the batch); journal/progress growth stays linear at high agent
  counts. `tierModelMap.small` defaults to the Nessy Gateway `fast`-aliased model
  (resolved by `resolveGatewayFastModelId` in `config/llm-connections.ts` when the
  session's gateway catalog exposes the alias) so read-only small-tier agents run
  on the cheap model; `medium`/`big` stay unset (session model). Non-gateway
  providers without a `fast`-class model keep today's behavior.

## Atomic update and rollback

1. Build and test the source-controlled runtime and session MCP server from the
   pinned lockfile; reject dependency, manifest, schema, or resource drift.
2. Stage both compiled resources with the Electron application and verify the
   closed registry, protocol version, descriptor hashes, and package inputs.
3. Stop admitting new Pi runtimes, drain the existing Pi workspace participant,
   and replace the application bundle atomically. Never run old and new Pi
   runtimes side by side as a fallback.
4. Start new sessions only after the host and child agree on the current
   manifest/protocol identity. Existing durable records use bounded one-way
   history normalization; live legacy manifests remain rejected.
5. On rollout failure, drain and stop the new runtime, atomically restore the
   previous complete signed application bundle, and reopen sessions from the
   existing durable store. Do not mix runtime resources across versions or
   rewrite user records during rollback.

## Warnings and deferred qualification

The workflow evaluator and five hook inventory gaps recorded above are now
closed (see "Measured parity"): the corpus records no P0/P1 partials. Live and
packaged real-model smoke tests remain reviewer/user checkpoints after offline
acceptance and before close-out.

Reviewer-authorized live smoke, run 2026-07-17 against the production
`pi-agent-server` JSONL protocol with the production interceptor preload and a
real Nessy Gateway JWT: `tgpt/qwen35-397b-a17b-fp8` produced a real bash tool
call that traversed the full extension-first path — descriptor-bound tool call,
pre-tool-use hook with a canonical-input-bound permission receipt, supervised
`process_start_request` under the `workspace` isolation profile, and the model
echoing the returned output. A deliberately incomplete receipt was rejected
fail-closed with `Invalid Pi permission canonicalInput`. Desktop restart
recovery, Nestor A2A remote, LSP provisioning, and the signed/notarized package
remain manual reviewer checks (feature branches have no signing secrets).

Marketplace/plugin execution, storage-plan migrations, Computer Use, the Codex
bridge, and broader project/workspace configuration are outside this
implementation. No ambient install or discovery is permitted to fill those
gaps.
