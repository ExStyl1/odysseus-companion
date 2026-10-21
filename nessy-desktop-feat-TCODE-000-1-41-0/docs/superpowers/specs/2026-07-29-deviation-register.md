TOTAL 363
{'not implemented': 326, 'impossible': 17, 'inapplicable': 20}

**Line numbers in the reasons below are a dated measurement, not a live pointer.** Each reason is harvested verbatim from a finished plan's deviation list and carries that plan's anchors, measured on the day it closed. They are deliberately never re-hung: renumbering a dated record turns what was measured into a claim nobody made. Re-measure and stamp your own date if you need a number that lands; the durable identifier is the quoted sentence and the named symbol. Regenerate with `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`.

### `docs/architecture/file-checkpoint-rewind.md`

- **not implemented** — a different identifier.
- **impossible** — checkpointing is unconditional.
- **impossible** — no equivalent CLI entry point.
- **not implemented** — no revert dry run.
- **not implemented** — no diff accounting.
- **not implemented** — no network-path detection.

### `docs/architecture/fork-subagents.md`

- **not implemented** — still unmeasured, but now measurable.
- **impossible** — the visible ancestor conversation instead of a terminal.
- **not implemented** — no such filter exists.
- **not implemented** — for non-forks.

### `docs/architecture/managed-mcp-access.md`

- **not implemented** — a separate deployment channel
- **not implemented** — falls out of the row above
- **not implemented** — the channel exists and we leave it open
- **not implemented** — enforcement is at load, feedback is not

### `plans/2026-07-29-codex-adapter-spec.md`

- **not implemented** — codex loads a root .mcp.json or .app.json only when the manifest declares no entry of its own; we import it alongside a declaration of another path or an inline object, so a server dead on codex is live here. Kept deliberately — narrowing would silently disable servers in bundles installed today — and disclosed by plugin.format.codex_undeclared_root_import
- **not implemented** — twelve specified interface fields including category, capabilities, defaultPrompt, the brand colours, the icon and logo paths and the three legal-link URLs are dropped at normalization, so every published Codex plugin loses the listing metadata it ships
- **not implemented** — the repository, license and keywords fields and the author email and url subfields are dropped at normalization, so a Codex plugin importing here loses its licence and its discovery tags
- **not implemented** — a Codex command hook carrying additionalContextLimit gets the host default instead of its declared budget, and one carrying commandWindows runs its POSIX command on Windows
- **not implemented** — the snake_case skill interface file that Codex validates with fourteen named errors has no reader, so a bundled Codex skill shows its slug rather than the display name and icon it ships

### `plans/2026-07-29-delivered-policy-enforcement.md`

- **not implemented** — SessionManager captures the policy once at construction and every subsystem built from it inherits that capture; making it live is its own unit. The

### `plans/2026-07-29-deviation-unit-1.md`

- **not implemented** — every nested instruction file is loaded eagerly at inventory time, so no traversal is lazy; those files truthfully report session_start

### `plans/2026-07-29-deviation-unit-2.md`

- **not implemented** — the Nessy Bash tool declares no

### `plans/2026-07-29-deviation-unit-3.md`

- **not implemented** — Nessy has no global tool-timeout env var (only
- **not implemented** — see propagation; buckets are keyed by logical name only, so a plugin pointing at the same URL or command as a scoped server is not detected as a duplicate

### `plans/2026-07-29-deviation-unit-4.md`

- **not implemented** — settings.md:206 wants a modal at startup listing stripped entries; we print the same content to the main log and to headless stderr instead. Cost: ~1 small slice in apps/electron/src/main/handlers/, alongside managed-approval-dialog.ts, which already owns a native startup modal.
- **not implemented** — settings.md:208's listing has no command because no /doctor command exists at all; R30b owns that surface. Cost: 0 for this unit — formatManagedPolicyDrop is the seam and renders the required source-and-field line today.
- **not implemented** — the key is parsed, carried and composed (resolveAutoModeClassifyAllShell); the band it controls does not exist. auto-mode-config.md:226 suspends Bash and PowerShell ALLOW rules while auto mode is active, and our auto-mode gate consults the judge only for a result that already reached 'prompt' (pi-agent.ts:3612), so a narrow Bash allow rule never reaches the classifier in the first p
- **not implemented** — needs an organization identity our shipped provider does not have. The Nessy Gateway JWT carries jwt/expiresAt/username/userId (AGENTS.md, nessy-cli's contract) and no org UUID, so there is nothing to compare. The one provider that DOES capture one is Claude OAuth (oauthOrganizationUuid on LlmConnection, from auth/claude-oauth.ts:parseClaudeOAuthIdentity), and it ships only under

### `plans/2026-07-29-deviation-unit-5.md`

- **not implemented** — no isolation profile is a read allowlist; every backend grants ambient whole-filesystem read and
- **not implemented** — the boundary is process-lifetime (one
- **not implemented** — an OS filesystem rule is "this path and everything under it" on every backend, so
- **not implemented** — the documented default
- **not implemented** — deliberate; the app's TLS client identity is withheld from supervised plugin processes.

### `plans/2026-07-29-deviation-unit-6.md`

- **not implemented** — the transaction receives the user's spelling and its realpath, and both are checked, which covers the documented consequence ("a rule written for one path also blocks targets that resolve to it"). Intermediate links of a multi-hop chain are not enumerated: a rule naming a MIDDLE link would not match. Enumerating them needs a resolver that walks each hop, which the cwd transaction does not have and
- **not implemented** — the target of a cd is by definition a directory the session is not in yet, so the OLD project's rules would decide a move out of it while the NEW project's are not loaded until the move commits. The tier set is managed + global + workspace + source
- **not implemented** — permissions.md gives Cd only allow and deny semantics. An ask rule compiles and is treated as a pure restriction: it never enables allowlist mode and never grants, and its outcome is the same prompt an unruled session gets
- **not implemented** — this repo runs one shell tool, so a PowerShell rule is entitled to judge exactly the commands our own PowerShell routing treats as PowerShell (
- **not implemented** — the two aliases exist in Windows PowerShell 5.1 only and were removed in PowerShell 7, and unlike every other alias their Unix meaning is a different and more capable program. An allow rule for
- **not implemented** — the project capability inventory withholds EVERY project-scope record when the project is untrusted (
- **not implemented** — we treat the local file exactly like the project file: project scope, trust-gated. The documented exception turns on running git to decide whether the repository could have supplied the file, and on a configuration-home carve-out; both are absent. The direction of the divergence is the safe one — a file the user wrote themselves is gated more tightly than documented, never less
- **not implemented** — the anchor needs the declaring settings file's directory, which the capability layer input does not carry, and compiling it without one fails the WHOLE layer closed, turning one unsupported rule into a deny of everything. Dropped with a diagnostic, which is the posture
- **not implemented** — no reader; out of this row's scope. See propagation
- **not implemented** — no reader exists for the user tier of Claude settings. See propagation
- **not implemented** — a durable repository grant for
- **not implemented** — the window map is in-memory on SessionManager and is cleared on session deletion and with the process. A session closed and reopened inside one app run keeps its answers, which is a longer reading of "session" than a CLI's, and still far shorter than the ten minutes it replaced
- **not implemented** — it would delete rules this session did not author, including an administrator's. The writer has no removal primitive at all, so the refusal is structural rather than a check
- **not implemented** — a session allow grant lives in the whitelist, which is keyed by base command and carries no rule identity to match a removal against
- **not implemented** — the whitelist carries the dangerous-base-command floor; a DSL allow rule would bypass it, so a hook could auto-approve
- **not implemented** — no reader for

### `plans/2026-07-29-doctor-surface.md`

- **not implemented** — R30b /status
- **not implemented** — slash-commands.md:23 makes /doctor a bundled prompt-based skill and we have that tier (ensureBundledSkills + skillSlashCommands), but a prompt cannot read managedPiPolicyDrops and session-tools-core cannot import server-core. Cost: 1 small slice — a managed target on the existing config_validate tool plus a diagnostics seam on SessionToolContext supplied by the host that holds the s
- **not implemented** — settings.md:229 names allow/ask/deny RULES, which is the permission DSL, and that surface is fully locked. Our pre-Claude MergedPermissionsConfig arrays (allowedTools, allowedWritePaths, readOnlyBashPatterns, readOnlyMcpPatterns, allowedApiEndpoints) are a separate widening surface with no Claude counterpart and — the blocking fact — NO SCOPE PROVENANCE: applyDefaultConfig/applyCust
- **inapplicable** — the clause is about PARENT-supplied settings from an embedding host's SDK managedSettings option, and it explicitly says "the key's effect on the developer's own permission rules comes from the highest-priority source only", which is our ordinary winner-takes-all. We have no parent-settings channel, so there is nothing to gap-fill and the key is not added to composeManagedPolicySour

### `plans/2026-07-29-effort-precedence.md`

- **not implemented** — model-config.md:315 gives Enterprise admins a per-role maximum effort level per model, so a level above the cap is not offered and a higher one named at launch runs at the cap instead. Our managed Pi policy has no effort key: availableModels, defaultMode and the permission-mode locks, nothing bounding reasoning depth. It needs a managed key plus a second narrowing rule
- **not implemented** — model-config.md:506 puts an environment variable above every other effort source, including the frontmatter override this unit just built, so the documented precedence has a top tier we lack. There is no CLAUDE_CODE_EFFORT_LEVEL analogue: the session level resolves caller, trusted project default, workspace default, global default, with no environment layer above any
- **not implemented** — model-config.md:499 and :501 set the level through an interactive slider command and a launch flag. Nessy sets it through the desktop thinking selector and the session RPC only. There is no slash command and no CLI flag, and the headless client has no effort surface of any kind, so a scripted run cannot choose one
- **not implemented** — model-config.md:503 and :508 make effortLevel a settings key whose managed-tier value is a starting default that re-asserts in new sessions. Our equivalent, defaultThinkingLevel, exists app-globally and for workspace and project defaults, but the managed tier has no entry: an administrator can set a default permission mode and cannot set a default reasoning depth
- **not implemented** — model-config.md:454 makes the default effort per model, high everywhere except one model defaulting to xhigh, and :456 holds that default across sessions until the user chooses explicitly. Our default is one constant for every model, medium, with no hold. The hold needs a persisted explicit-choice flag our stored level cannot distinguish from an inherited one
- **not implemented** — model-config.md:458 makes max session-only while the four lower levels persist across sessions. Every Nessy level persists identically, so a session raised to max leaves max as the default for the next one
- **not implemented** — model-config.md:462 makes ultracode an effort-menu entry that sends xhigh AND orchestrates dynamic workflows, for the current session only. Nessy has the workflow half under the same name but as a per-prompt keyword gated to human-typed input, appending a directive to one turn and never touching the effort level. The effort behaviour and the session scope do not match
- **not implemented** — model-config.md:493 recognises ultrathink anywhere in a prompt as a request for deeper reasoning on that turn, adding an in-context instruction while leaving the level sent to the API unchanged. Nessy recognises no such keyword, so the word reaches the model as ordinary prompt text, which is what the same paragraph says happens to think and think hard
- **not implemented** — sub-agents.md:316 says a subagent inherits the main conversation extended-thinking configuration, on stays on and off stays off, with no per-subagent thinking setting, while the effort frontmatter overrides the session level. Two axes in Claude, one enum here: off is a Nessy level below low, so a subagent declaring an effort raises itself out of a parent that turned thinking off
- **not implemented** — model-config.md:527 stores a global thinking toggle, :528 turns thinking off regardless of effort through an environment variable, :518 reverts two named models to a fixed thinking budget, and :532 controls whether full reasoning summaries are available when expanded. None of the four has a Nessy equivalent. Our token-budget fallback derives from the level rather than being settable
- **not implemented** — model-config.md:444 says models absent from its per-model table do not support effort at all. Our clamp encodes only families we positively know to be narrower, because Nessy runs unlisted models that demonstrably reason: Haiku on a fixed token budget, and every discovered gateway model. Read literally it would resolve all of those to off and disable reasoning across the Pi provider set
- **not implemented** — model-config.md:668 lets a deployment declare a pinned model capabilities with a companion environment variable, naming effort, xhigh_effort and max_effort among its values. That is the data-driven source our clamp table would otherwise read, and what a Bedrock ARN or Foundry deployment name needs. Without it the clamp cannot narrow a provider-specific id at all
- **not implemented** — model-config.md:690 maps individual Anthropic model ids to provider-specific strings, applying to picker selections and, since a named version, to ids passed through the model flag and the family environment variables. Nessy has a same-named concept for custom-endpoint capability overrides inside the Pi runtime, a different thing, and no id mapping layer at all
- **not implemented** — model-config.md:344 makes one alias a mode-sensitive hybrid, using the larger model in plan mode and switching to the smaller one for execution. Nessy resolves a model once per session and has no mode-triggered switch; our tier map is per subagent rather than per permission mode
- **not implemented** — model-config.md:361 configures an ordered chain of fallback models tried when the primary is overloaded or fails non-retryably, and :390 adds classifier-driven fallback re-running a flagged request on a named other model. Neither exists. A single fallbackModel string is parsed, defaulted and trimmed in the stored config and read by nothing

### `plans/2026-07-29-fork-subagents.md`

- **impossible** — <the nearest Pi-ecosystem equivalent we shipped>
- **not implemented** — <reason and rough cost>

### `plans/2026-07-29-fork-surface.md`

- **not implemented** — sub-agents.md:1046 says a fork's first request reuses the parent's prompt cache. Now MEASURABLE where R29a could not measure it: pi-ai's openai-completions adapter maps prompt_tokens_details.cached_tokens (or prompt_cache_hit_tokens) to cacheRead, and our Pi event adapter surfaces it as cacheReadTokens. The number exists end to end; two things still block a result, and neither is code we own
- **not implemented** — the first blocker is credentials: the number needs one live turn per arm, forking and spawning a named subagent from the same parent and comparing each first request's cacheRead. The offline harness stubs the provider. The second is the gateway, which must populate cached_tokens on an OpenAI-compatible response; if it reports nothing the arms must run against an Anthropic-shaped connection
- **not implemented** — one precondition R29a named is now satisfied rather than outstanding: the session-memory divergence that broke prefix identity for any parent with session memory is fixed, so a cache-sharing measurement would at last be measuring the thing the row describes. Cost is a live-credential probe of about half a day, most of it establishing whether the gateway reports cache tokens at all
- **not implemented** — sub-agents.md:997 and :895 make /fork a DIFFERENT feature since v2.1.212: it copies the whole session into a new background session with its own budget, while /subtask is the in-session fork this slice shipped. We have no background-session surface for a conversation to be copied into. Branching a session exists in the UI, but it produces an ordinary visible session, not a detached run
- **inapplicable** — sub-agents.md:997 adds that when agent view is turned off, /subtask is not available and /fork starts the forked subagent instead. That is a fallback for a toggle we have no counterpart to; there is no agent-view setting here, so /subtask is unconditional and the substitution has nothing to trigger it
- **not implemented** — sub-agents.md:1019 says the fork's result arrives as a message in your main conversation. A model-spawned fork's result does return through its tool call, but a /subtask fork has no owning tool call, and the session event union has no append-an-assistant-message event; user_message is the only one. Its output is readable in the panel instead. One event type plus a renderer handler, about a day
- **not implemented** — sub-agents.md:1032 says that with an agent's transcript open, typing /model or /fast shows a notice that it changes the main conversation rather than the viewed agent. The panel's follow-up field sends a steer and parses no slash commands at all, so there is nowhere to put the notice and no silent misapplication to warn about. It becomes real only if that field grows command handling
- **not implemented** — sub-agents.md:1032 also routes skills typed into an open transcript to that agent while built-in commands stay in the main conversation. Our follow-up field is a plain steer message: a skill reference reaches the child as text, and the child invokes skills through its own inherited tools. Splitting the two needs the composer's skill resolution behind the panel input, half a day
- **impossible** — sub-agents.md:1044 says a fork's permission prompts surface in your terminal. There is no terminal here. The nearest equivalent shipped is this slice's routing: the prompt is filed under the visible ancestor conversation and rendered there with the asking agent named, which is what :770 and the named-subagent half of :1044 ask for, and answering it unblocks the child

### `plans/2026-07-29-hook-context-injection.md`

- **not implemented** — both executors run matched command hooks sequentially with
- **not implemented** — no dedupe by command string or
- **not implemented** — Nessy renders assistant text in the renderer, not through a per-line interception seam; imported hooks defer with
- **inapplicable** — an agent-teams event with no counterpart product surface; deferred with
- **not implemented** — the type exists to verify against "actual files or test output, not just evaluating the hook input data alone" (
- **not implemented** — the tool is invoked, but
- **not implemented** — the request fires with
- **not implemented** — no env-file preamble is sourced before Bash tool calls, so the direnv recipe's
- **not implemented** — the managed Pi policy governs whether plugin hooks may run, but declares no hooks of its own, so
- **not implemented** — no frontmatter
- **not implemented** — project-scope hooks appear in the Sources panel and native automations in the Automations list; there is no single browser across all locations. -
- **not implemented** — no such setting; the managed policy's hook lock is the nearest control and is admin-only. -
- **inapplicable** — the section describes a shell-profile problem in the user's
- **not implemented** — the direct runner predates the supervised one and was never given the stdin half. -
- **not implemented** — moving the emission host-side (as
- **not implemented** — the two limits were added by different units and neither knew about the other. - The Codex adapter still carries the agent-hook defect Task 3 fixed.
- **not implemented** — needs a real Codex manifest to settle the field name before either half can be fixed. - A documented agent hook now makes its plugin
- **not implemented** — no documented cancellation semantics for a
- **not implemented** — the child would need the fork fact threaded through its

### `plans/2026-07-29-inert-unit-b.md`

- **not implemented** — Nessy has no
- **not implemented** — our ConfigChange reports runtime session-config keys, not the five settings-file sources. Ours fires on
- **not implemented** — no command name in the payload. hooks.md's event fires when "a user-typed command expands into a prompt"; Nessy's fires once per turn at
- **not implemented** — Nessy has no --init/--maintenance launch mode; the documented vocabulary has no counterpart
- **not implemented** — our ConfigChange reports runtime session-config keys, not the five settings-file sources
- **not implemented** — our event fires once per turn at agent start and carries no expanded command name
- **not implemented** — no Nessy teardown path produces them
- **not implemented** — no Nessy ErrorCode maps to either
- **not implemented** — no Nessy emitter

### `plans/2026-07-29-inert-units-cd.md`

- **not implemented** — the spawn failure surfaces as the hook error notice instead of a load-time warning
- **not implemented** — neither adapter reads it; the host wrapper selects the platform shell itself and ignores the field when
- **not implemented** — Nessy emits no MessageDisplay event (recorded in the U-B close-out)
- **not implemented** — Nessy has no settings-file hook tier that could raise it; a plugin hook may not raise it by contract, which is the case implemented
- **not implemented** — permissions.md specifies a warning; the managed tier's own recorded posture strips an entry that enforces nothing, and the drop record is its admin-facing surface

### `plans/2026-07-29-isolation-hardening.md`

- **not implemented** — unverifiable on the development platform
- **not implemented** — sandbox-environments.md:24 and :78 put the whole-process boundary in the sandbox runtime or a container, never in a fifth per-command profile. isolated-code promises the declared-input READ boundary no backend has, and the leak it would answer sits in the DEFAULT read posture, which an opt-in profile leaves exactly where it is. Retire it in favour of the read-allowlist posture
- **not implemented** — sandboxing.md:80 makes the seccomp filter the only thing that blocks Unix domain sockets and ships it as an optional npm helper, and :474 names docker.sock as the escalation it stops. Our bwrap argv passes no seccomp option, and the abstract namespace is unreachable by ro-bind. Unverifiable on the development platform: proving it needs a Linux host

### `plans/2026-07-29-marketplace-entry-authority.md`

- **not implemented** — <reason and cost>
- **not implemented** — a top-level renames entry maps a plugin's former name to its current one, or to null when removed, so a user migrates instead of seeing plugin-not-found; Claude also rewrites the old key in enabledPlugins and pluginConfigs in every editable scope, following chains. Nessy keys a plugin by marketplace id plus plugin id with no rename channel, so a rename reads as a new plugin and the old as missing.
- **not implemented** — allowCrossMarketplaceDependenciesOn names the other marketplaces whose plugins this one may depend on, and a dependency from a marketplace not listed is blocked at install. Nessy has no cross-marketplace dependency resolution at all, so there is no install-time edge for the list to gate.
- **not implemented** — sixteen names are reserved for official Anthropic use and are re-checked every time a marketplace loads, not only when it is added, so a third-party marketplace registered under one stops loading as an untrusted source. Nessy accepts any name. The reservation protects a namespace a T-Bank fork does not publish into, so the cost falls only on a user who adds an impersonating public marketplace.
- **not implemented** — an entry can carry relevance signals that tell Claude when to suggest the plugin, taking effect only for marketplaces an administrator allowlists through pluginSuggestionMarketplaces in managed settings. Nessy has no contextual plugin-suggestion surface for the signals to feed, so the field is dropped at catalog parse rather than carried into a definition nothing reads.
- **not implemented** — blockedMarketplaces takes the same enforcement path as the allowlist and blocks named sources outright, and disableSideloadFlags rejects the CLI flags that sideload plugins, agents and MCP servers for one run. S9 implements the allowlist only. On a managed fleet the allowlist is the stronger control, since anything unlisted is already refused, so the blocklist adds reach not safety.
- **not implemented** — extraKnownMarketplaces in project or managed settings registers a marketplace automatically, so team members are prompted to install it when they trust the project folder, and it is the documented partner of the allowlist. Nessy registers a marketplace only through an explicit add, so an administrator can restrict which sources are permitted but cannot pre-supply one.
- **not implemented** — the add command takes a sparse option limiting the checkout to named directories through git sparse-checkout, and a git-subdir plugin source is documented to clone sparsely to minimise bandwidth for monorepos. Nessy records the requested paths on the registry row and clones in full, so a large monorepo marketplace costs its whole tree on every fetch. Correctness is unaffected; bandwidth is not.
- **not implemented** — a seed directory pointed at by an environment variable lets a container image start with marketplaces and plugin caches already present and never clone at runtime, with seed entries outranking user configuration, remove and update refused against them, and paths probed at the mount rather than trusted from the seed. Nessy has no seed layer, so a container image re-clones on first use.
- **not implemented** — three variables tune marketplace git behaviour: keeping the existing clone when a background pull fails instead of re-cloning, raising the 120-second git timeout, and cloning GitHub shorthand sources over HTTPS rather than SSH. Nessy has its own 45-second registry fetch timeout and no background pull at all, so two of the three describe a mechanism we do not run.
- **not implemented** — a plugin version resolves from plugin.json, then the marketplace entry, then the git commit SHA of the plugin source, so a plugin that declares no version anywhere still gets a new version on every commit. S9 implements the first two. With neither declared the Claude adapter stamps 0.0.0, so an actively developed plugin with no version field never appears to change and the cached copy is kept.
- **not implemented** — the page's own advanced entry example declares hooks and mcpServers as inline configuration objects rather than paths, and that is the shape a marketplace operator uses to add a hook to a plugin that ships none. Nessy records the inline object as a deferred compatibility entry and builds no capability from it, matching how the same inline form is already treated in a plugin manifest.
- **not implemented** — an entry defines components for whatever bundle its source contains, but only the Claude adapter reads one, because plugin-marketplaces.md is the contract that defines an entry. A bundle normalising as Codex, MCPB, native or legacy Nessy leaves its entry component fields unread; the install warns, naming the adapter that read the bundle, so they go unread but not unreported.
- **not implemented** — each user may register only one marketplace per name, and adding a second with the same name replaces the first. Nessy dedupes on the raw source string instead, so two different sources whose catalogs declare the same marketplace name coexist and their plugins are told apart only by the registry id we mint per add.
- **not implemented** — the validate command run against a marketplace directory checks the catalog for schema errors, duplicate plugin names and source path traversal, validates each local entry's own plugin.json, warns when an entry version disagrees with the manifest, and rejects a cyclic rename chain. Nessy validates a catalog only while fetching it, and offers no author-facing command.
- **not implemented** — an entry may carry category, tags, keywords, license and repository. S9 carries the metadata the adapter can act on and leaves these five, because nothing in the Nessy plugin record or browse row reads them; carrying them would persist untrusted catalog text no consumer displays.
- **not implemented** — distributing a marketplace through the Anthropic organization settings surface reads a private repository through the Claude GitHub App, forbids npm plugin sources, packages private plugin folders during distribution, and restricts which plugin sources may be private. That is an Anthropic-hosted product surface, and a T-Bank fork distributes through its own GitLab instead.

### `plans/2026-07-29-nestor-cloud-verification.md`

- **impossible** — the real Nestor gateway transport for a tool result (TLS, the Nestor-Token header, a 401 or 5xx on the tool-result POST, and the SSE framing the live service emits) needs live credentials, so the end-to-end cases stop at the JSON-RPC body handed to a stubbed fetch; nestor-cloud-e2e.test.ts already gates a live case on NESSY_NESTOR_CLOUD_E2E and it stays skipped
- **impossible** — whether the remote Nestor agent honours a delivered error, a denial, or an empty content field is the remote model's behaviour and not ours; the cases prove the result leaves this process in the documented tool_call_id plus content plus error shape, and nothing beyond that is provable without the live agent
- **not implemented** — no end-to-end case drives a remote Nestor MCP tool call through McpClientPool, so the pool-backed leg of the path is proven only from the executor down by tool-executor.test.ts (proxy-name resolution, permission subject, abort propagation) while the turn and client plumbing above it is proven only by the builtin cases
- **not implemented** — the two terminal Nestor tools ask_followup_question and plan_mode_respond are not driven end to end, so the composition of the adapter's terminal flag with the turn suppressing local tool cards is proven only in halves, by turn.test.ts with a stubbed executor and by tool-executor.test.ts with a hand-built call

### `plans/2026-07-29-observability-and-cost.md`

- **not implemented** — llm-gateway-protocol.md:78 and :79 define x-claude-code-agent-id and x-claude-code-parent-agent-id, each "present only on requests from an agent Claude Code spawned inside the session", to be used "with the session ID to attribute cost to parallel agents". Nessy emits the session header alone. There is no producer for either id: a Pi child session is its own subprocess carrying its own NESSY_SESSI
- **not implemented** — agent-sdk/typescript.md:4111 adds canonicalModel and provider to ModelUsage, and :4116 says both require Claude Code v2.1.218; canonicalModel "is the canonical model ID that the pricing lookup uses; it can differ from the raw model string that keys the entry". The installed @anthropic-ai/claude-agent-sdk typings declare eight fields and neither of those two, so the persisted per-model map is keyed
- **not implemented** — monitoring-usage.md:472 through :479 list eight metrics. Task 3 emits the two the row named, token.usage and cost.usage. The other six have no counterpart: session.count, lines_of_code.count, pull_request.count, commit.count, code_edit_tool.decision and active_time.total. Each needs its own emission site rather than more exporter code, and lines_of_code and commit would need a diff and a git obser
- **not implemented** — monitoring-usage.md:530 gives the cost and token counters a query_source attribute, "One of main, subagent, or auxiliary", and :533 to :538 add agent.name, skill.name, plugin.name, marketplace.name, mcp_server.name and mcp_tool.name with per-source redaction rules. Our data points carry backend, model, type and cost_reporting. The session layer sees a completed turn, not which subsystem issued eac
- **not implemented** — monitoring-usage.md:446 to :455 define the standard attribute set every metric shares: session.id, app.version, app.entrypoint, organization.id, user.account_uuid, user.account_id, user.id, user.email, terminal.type, and OTEL_RESOURCE_ATTRIBUTES passthrough, each with its own OTEL_METRICS_INCLUDE_* toggle. Ours carries none of them, and that is a decision rather than an omission: this is a bank fo
- **not implemented** — monitoring-usage.md:106 to :110 define five content channels: OTEL_LOG_USER_PROMPTS, OTEL_LOG_ASSISTANT_RESPONSES, OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT and OTEL_LOG_RAW_API_BODIES, the last of which ":110" says carries "the entire conversation history". None exists here, and :1278 shows the doc's own default is the same as ours — "User prompt content is not collected by default. Only promp
- **not implemented** — monitoring-usage.md:144 opens the traces beta: CLAUDE_CODE_ENHANCED_TELEMETRY_BETA plus OTEL_TRACES_EXPORTER, a span hierarchy at :175 rooted at claude_code.interaction with llm_request, hook and tool children, tool spans splitting into blocked_on_user and execution, and TRACEPARENT propagated into Bash subprocesses. Nessy exports no spans of any kind. This is the largest single gap in the monitor
- **not implemented** — monitoring-usage.md:605 through :1089 name twenty-three log events, from user_prompt and api_request to plugin_loaded, skill_activated, compaction and hook_execution_complete. The existing exporter emits six Pi-harness lifecycle events and only for Pi (otlp-telemetry.ts:13, and SessionManager.emitPiTelemetry returns early unless the provider is pi). Task 3 left that file alone on purpose: it belon
- **not implemented** — monitoring-usage.md:105 gives logs their own OTEL_LOGS_EXPORT_INTERVAL, "Logs export interval in milliseconds (default: 5000)". The pre-existing log exporter has no interval at all: scheduleFlush uses queueMicrotask, so a batch leaves as soon as the event loop turns and the variable is ignored. Task 3 added the interval on the metrics path only. Fixing the log path is a two-line change inside anot
- **not implemented** — monitoring-usage.md:95 makes OTEL_METRICS_EXPORTER a comma-separated selector over console, otlp, prometheus and none, and :481 describes a Prometheus scrape that drops the USD, tokens and s units so the text format stays valid. Ours is otlp-or-nothing, keyed off whether an endpoint is set. A console exporter is cheap; a Prometheus scrape endpoint is a listening socket in a desktop app and wants i
- **not implemented** — monitoring-usage.md:112 offers OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, "Metrics temporality preference (default: delta). Set to cumulative if your backend expects cumulative temporality". Task 3 emits delta unconditionally, which matches the documented default and is what makes the shutdown drain load-bearing, but a backend that wants cumulative has no switch. Also unimplemented: the pe
- **not implemented** — costs.md:32 shows the /usage screen's "Usage by model" block, one line per model with input, output, cache read, cache write and a dollar figure. Task 2 now persists exactly that breakdown on SessionTokenUsage.modelUsage, and no surface renders it: the usage overlay shows session totals plus the new cost verdict. This is a UI task with its data already in place, which is the cheapest row on this l
- **inapplicable** — analytics.md:12 routes team reporting to two hosted dashboards, claude.ai/analytics/claude-code for Teams and Enterprise and platform.claude.com/claude-code for API customers, with a leaderboard, CSV export and a GitHub app for contribution metrics. All of it is Anthropic-operated infrastructure keyed to an Anthropic organization. Nessy sessions run against the T-Bank gateway and have no Anthropic
- **inapplicable** — costs.md:65 and :76 place organization cost control in Anthropic billing surfaces: Console workspace spend limits, per-member and per-group spend limits, usage credits, and the /usage-credits command that "isn't available with API key authentication" (:36). These govern an Anthropic account's money. The Nessy equivalent already exists and is ours: workspaceDefaults.maxBudgetUsd, enforced on the co
- **inapplicable** — llm-gateway-protocol.md:95 describes a system-prompt attribution block that the api.anthropic.com endpoint "strips before processing when it arrives unchanged as the first system block", with CLAUDE_CODE_ATTRIBUTION_HEADER=0 to suppress it. The Nessy Gateway is an OpenAI-like endpoint, not an Anthropic Messages one, so no reader of that block sits behind our base URL and prepending one would put c

### `plans/2026-07-29-output-style-contract.md`

- **not implemented** — output-styles.md:21 ships a Proactive built-in style that executes immediately, makes reasonable assumptions instead of pausing for routine decisions, and prefers action over planning, without changing the permission mode. Nessy ships four built-ins, Default, Concise, Explanatory and Reviewer, and none of them is an autonomy posture. The nearest thing we have is auto mode, which the same line call
- **not implemented** — output-styles.md:25 ships a Learning built-in style that asks the user to contribute small strategic pieces of code and marks the spots in the file with a TODO(human) marker. Nessy has no collaborative style and no marker convention, so the learn-by-doing half of the built-in set has no equivalent
- **not implemented** — output-styles.md:23 makes Explanatory emit educational Insights interleaved with the work, a named and recognisable output convention. Our explanatory built-in asks only for reasoning and tradeoffs in prose, with no Insights marker, so the same style name produces differently shaped answers in the two products
- **not implemented** — output-styles.md:29 saves the selection to a settings file at the local project level, so the style can differ per repository. Nessy stores outputStyleId once, app-globally, in config.json. There is no per-project selection, so a user who wants one voice in one repository and another elsewhere has to change the global setting every time they switch projects
- **not implemented** — output-styles.md:33 makes the selection an ordinary settings key editable directly in any settings file, which puts it under the documented settings precedence with its managed, user, project and local tiers. Ours is a private config.json field written only by one RPC handler, so no administrator and no repository can set or pin it and no precedence applies to it
- **not implemented** — output-styles.md:53 adds a managed policy level, an output-styles directory inside the managed settings directory, so an enterprise deployment can ship a house style. Nessy reads a user directory, a workspace directory and a trusted project directory, and has no managed tier for styles at all
- **not implemented** — output-styles.md:55 loads project styles from every nested directory between the working directory and the repository root, and resolves a same-name collision to the one closest to the working directory. We read exactly one project directory, the working directory's own, so a style defined at the repository root is invisible from any subdirectory
- **not implemented** — output-styles.md:41 reads the output style once at session start and needs a clear or a new session before a change takes effect. Nessy re-reads the app-global selection every turn, so a change lands mid-session and rewrites the cacheable system prefix underneath a running conversation. Ours is the friendlier behaviour and the cache cost is real, and it is a deviation in either direction
- **not implemented** — output-styles.md:101 says all output styles trigger reminders to adhere to the style during the conversation, a second injection point beyond the system prompt. Nessy injects the style block once, in the system prompt, and never restates it, so a long conversation drifts back toward the default voice with nothing to pull it back
- **not implemented** — output-styles.md:94 defines force-for-plugin, which applies a plugin's style automatically whenever the plugin is enabled and overrides the user's own selection, with the first enabled plugin winning. Three things would have to be true before it could be safe here. Plugin-shipped styles would have to exist at all, which B1c did. A plugin style would have to pass the same trust gate a project style
- **not implemented** — output-styles.md:29 and :79 put the picker behind a /config slash command, so the style can be changed from inside the conversation. Nessy exposes it only on the desktop Settings AI page over an RPC pair. There is no slash command and the headless CLI has no output-style surface, so a scripted or terminal run cannot see or change the active style
- **not implemented** — output-styles.md:102 says a custom output style leaves out the built-in software engineering instructions. On the Pi backend it now does. On the Claude backend our whole prompt is an append to the claude_code preset, and the preset's own coding guidance lives inside the SDK where an append cannot subtract it, so keep-coding-instructions false removes Nessy's engineering sections and leaves Claude
- **not implemented** — output-styles.md:125 points at a configuration doctor for diagnosing why an output style is not taking effect. Our config doctor says nothing about styles: it cannot report which of the three roots the active id resolved from, nor that a project style was skipped because the project is untrusted, which is now the most likely reason a style a user can see in their repository does not apply
- **not implemented** — modifying-system-prompts.md:148 selects an output style through an outputStyle key inside the inline settings object passed to query, or through a settings file the same option points at. Nessy never passes it: we resolve the style ourselves and fold it into the append text. The consequence is on the other side of the same seam, because we do pass settingSources with project and local, so on the C
- **not implemented** — modifying-system-prompts.md:120 stores styles at a user path and a project path under the .claude namespace. Nessy reads .nessy-agent/output-styles and a user directory under the Nessy configuration root, and reads .claude/output-styles nowhere. A style file authored for Claude Code is therefore invisible here even though our plugin adapters exist precisely to import Claude components, and the fil
- **not implemented** — modifying-system-prompts.md:405 layers a session-specific append on top of a persistent output style, so one session can add focus areas without editing the saved style. Nessy has no append surface of any kind for a user or a caller. The append slot is fully occupied by our own composed prompt, so the two customization methods the page says compose cannot compose here
- **not implemented** — modifying-system-prompts.md:271 names a non-interactive CLI flag for excluding the dynamic system prompt sections. Our headless CLI has no flag for it. The behaviour itself is on unconditionally on the Claude path, which is the safer default for caching and the wrong one for a caller who wants the environment context back in the system prompt, and there is no way to ask
- **inapplicable** — modifying-system-prompts.md:22 describes the minimal default the SDK uses when no system prompt is set, tool calling and nothing else. Nessy is a product with one prompt strategy per backend rather than an SDK surface, so there is no caller who could choose it and nothing that would work if they did
- **inapplicable** — modifying-system-prompts.md:154 and :334 cover the Python SDK, which has no programmatic output-style option and needs a file-typed system prompt to avoid the argument-length limit at process spawn. Nessy has no Python SDK path; the Claude backend spawns the SDK's own native binary and Pi runs in a Bun subprocess

### `plans/2026-07-29-plugin-activation-and-styles.md`

- **not implemented** — the install-time half of settings.md:793, where a managed enabledPlugins entry blocks installation at all scopes and not merely hides an installed plugin. Task 1 shipped the hiding half: a blocked plugin activates nothing and reaches no listing that filters through isManagedPluginAllowed. The refusal belongs in the install service, held by another agent:
- **not implemented** — the per-marketplace autoUpdate boolean of settings.md:879, which refreshes a marketplace and updates its installed plugins in the background after startup. No such field is parsed anywhere, and the update it would drive does not exist: upgrade only re-fetches the catalog clone, and availableUpdateVersion has no producer, so canUpdate is always false:
- **not implemented** — output-styles.md:94 force-for-plugin, which overrides the user's own selection. The adapter now reads it and records it as a deferred surface per bundle, so an author who asked for it is told; nothing applies it. The preconditions are S11's row on this same field in 2026-07-29-output-style-contract.md, whose first one — that plugin styles exist — Task 2 met:

### `plans/2026-07-29-plugin-authoring-tooling.md`

- **not implemented** — plugins/cli-reference.md#plugin-prune (was line 993 of the retired plugins-reference page) prune removes auto-installed dependencies no other plugin requires, :1018 enable resolves dependencies transitively, and :1037 disable fails when an enabled plugin depends on the target. All three need the dependencies manifest field, unparsed here, plus an auto-installed provenance bit to tell a pulled-in p
- **not implemented** — plugins/cli-reference.md#plugin-tag (was line 1152 of the retired plugins-reference page) has plugin tag create a release git tag so a semver dependency constraint can resolve to it. Tagging is only useful once dependency resolution reads those tags, so it belongs inside the dependency subsystem rather than ahead of it as a standalone verb
- **not implemented** — plugins/cli-reference.md#plugin-details (was line 1148 of the retired plugins-reference page) computes the always-on total through the count_tokens API for the active model, and falls back to a character estimate only when that API is unreachable. This repository has no count_tokens caller anywhere and the CLI holds no model connection, so the fallback is the only path implemented and both output
- **not implemented** — plugins/cli-reference.md#plugin-details (was line 1120 of the retired plugins-reference page) prices each component when it fires and shows the figure per component. Computing it needs every skill, agent and command body read out of the installed bundle cache and counted, a second reader over bundle paths. The details verb reports on-invoke as null, named as not computed rather than shown as a zer
- **not implemented** — plugins/cli-reference.md#plugin-list (was line 1089 of the retired plugins-reference page) lets plugin list include available plugins from marketplaces, requiring --json. That is a marketplace catalogue fetch rather than a registry read, so the verb would stop working offline and would pull in the registry source with its network and auth path. Every other column this listing prints comes from loc
- **not implemented** — plugins/cli-reference.md#claude-plugin-commands (was lines 926-1074 of the retired plugins-reference page) give install, uninstall, enable, disable and update a CLI form with scope and config flags. Every one of those operations already exists here behind the plugins manage RPC and the plugin manage session tool, so the gap is the terminal entry point rather than the capability
- **not implemented** — plugins/cli-reference.md#plugin-validate (was line 1192 of the retired plugins-reference page) names a slash form of validate alongside the terminal one, run inside a session against a directory path. The validator this slice added is host side and reachable from the CLI only; a session form needs a command or tool definition plus a decision about which paths a session may be pointed at
- **not implemented** — plugins/cli-reference.md#plugin-init (was line 874 of the retired plugins-reference page) scaffolds a plugin under the skills directory, with a --with list naming component folders to seed. The create-plugin command and the bundled plugin-creator skill already scaffold a bundle here, and they do it with a model that fills the starter files from the user's description, so a second non-interactive s

### `plans/2026-07-29-plugin-user-config.md`

- **not implemented** — substitution of a configured user_config value into MCP and LSP server configs and into skill and agent content, which plugins/manifest-reference.md#environment-variables (was line 577 of the retired plugins-reference page) declares; the option schema, the sensitivity-split storage and the hook environment export all landed here, so the engine is the one remaining half, measured by the B1 audit at
- **not implemented** — the per-channel user_config a channels entry may declare, which plugins/manifest-reference.md#channels (was line 630 of the retired plugins-reference page) says uses the same schema as the top-level field; channels are still a wholly deferred surface here, so the option schema has nothing to hang off and the work belongs inside the channels slice:
- **not implemented** — the install flag that sets one user_config option non-interactively, plugins/cli-reference.md#plugin-install (was line 943 of the retired plugins-reference page); there is no plugin install CLI surface in Nessy for the flag to ride, so it needs that surface before it needs anything else from this slice, measured at one slice:
- **not implemented** — the enable-time prompt dialog for user_config, which plugins/components.md#when-the-configuration-dialog-appears (was line 544 of the retired plugins-reference page) makes the whole point of the field; values are collected only through the existing configure API, and no renderer surface renders an option title, its description, a masked sensitive input or a directory picker, measured at one slice:
- **not implemented** — the refusal of a user_config reference in an MCP headersHelper command, plugins/manifest-reference.md#environment-variables (was line 585 of the retired plugins-reference page) with the wording at errors.md:1384; headersHelper appears nowhere in this repository, so the field the guard protects is never parsed and the check has no place to run until MCP dynamic headers exist:
- **not implemented** — the refusal of a user_config reference in a monitor command, plugins/manifest-reference.md#environment-variables (was line 584 of the retired plugins-reference page) with the wording at errors.md:1378; monitor configs are recorded as a deferred surface and never parsed, so this check must ship inside the monitors slice the B1 audit sized as a subsystem:
- **not implemented** — the documented sensitive and non-sensitive storage split for MCPB user_config values; the MCPB adapter still routes every value to the credential manager, which is stricter than plugins/manifest-reference.md#where-values-are-stored (was line 589 of the retired plugins-reference page) rather than conformant, and loosening it would move already-stored secrets into a plaintext file:
- **not implemented** — MCPB user_config options that declare multiple, still refused outright by the MCPB adapter; Claude's multiple is an array of strings for one option and MCPB's is a repeatable argument inside an mcp_config, so widening the shared descriptor does not settle the MCPB semantics:
- **not implemented** — the required-ness of the title and description on a user_config option, plugins/manifest-reference.md#user-configuration (was line 569 of the retired plugins-reference page) and :570; an option that omits them is imported with a warning rather than refused, because refusing would cost the user a working option in order to enforce a caption:

### `plans/2026-07-29-removal-circuit-breaker.md`

- **impossible** — <equivalent>
- **not implemented** — outside the docs' removal examples, and

### `plans/2026-07-29-rewind-link-safety.md`

- **impossible** — <equivalent>

### `plans/2026-07-29-sandbox-network-enforcement.md`

- **not implemented** — sandbox-environments.md:69 has the sandbox prompt "the first time a command needs a new network domain". Our foreground shell pins the networked profile and the darwin profile emits (allow network*), an owner decision of 2026-07-28 restated at packages/pi-agent-server/src/index.ts. S12 wired allowManagedDomainsOnly to a total egress deny; the per-domain layer is R19
- **not implemented** — sandbox-environments.md:33 warns isolation "does not eliminate risk. Any approach that allows network egress can still leak data the agent can read". Re-probed 2026-07-29 under the real composed profile: Chrome Default/Cookies, ~/.docker/config.json and ~/.gitconfig were readable, ~/.ssh and ~/.aws blocked. A credible floor needs an allowlist read posture, not a longer deny list
- **inapplicable** — sandbox-environments.md:82 wraps the whole Claude Code PROCESS by launching it through npx @anthropic-ai/sandbox-runtime, configured in ~/.srt-settings.json. Nessy Desktop is an Electron app and a headless server, neither of which a user launches through npx, and the process it would wrap is the one holding the user's credentials
- **inapplicable** — sandbox-environments.md:96 defines a dev container as a .devcontainer/ directory a user commits to their own repository, and :125 calls it "a convention rather than an enforcement boundary". It is a repository artifact of the project being worked on, not a feature of the agent working on it; nothing in Nessy could implement it on the user's behalf
- **not implemented** — sandbox-environments.md:106 -- "Unprivileged containers need the nested-sandbox setting", i.e. enableWeakerNestedSandbox, which makes bubblewrap bind-mount the container's existing /proc instead of a fresh one. We have no such key: resolveLinuxIsolation fails closed with process-isolation-unavailable, so Nessy cannot run inside an unprivileged container at all
- **inapplicable** — sandbox-environments.md:110 is user infrastructure -- a cloud instance, a local hypervisor or a microVM the user provisions and installs the app into. There is no code path an application can take to place itself inside one, and the app is already inside whatever VM the user booted
- **inapplicable** — sandbox-environments.md:116 is an Anthropic-hosted product: sessions run in Anthropic-managed VMs behind an Anthropic egress proxy, reached with a Claude subscription. Nessy has no hosted execution tier and the gateway it does have is an inference endpoint, not a session host
- **not implemented** — sandbox-environments.md:71 enables the per-command sandbox with /sandbox, whose panel carries Mode, Overrides and Config tabs (sandboxing.md:29). Supervised-process isolation here is unconditional rather than opt-in, so Mode and Overrides have no analogue to toggle; the Config tab's "view the resolved sandbox settings" is what S12 added to nessy-general-agent doctor instead
- **inapplicable** — sandbox-environments.md:66 says the sandboxed Bash tool "does not support native Windows" and directs Windows hosts to WSL2 or a container. We ship a native Windows isolation backend instead (resolveWindowsIsolation, a verified Codex restricted-token runner with a host-owned permissions profile), so the row's guidance describes a limitation Nessy does not have

### `plans/2026-07-29-session-scheduling.md`

- **impossible** — <equivalent shipped>
- **not implemented** — requires /loop, which is not in this slice

### `plans/2026-07-29-stop-hook-payload.md`

- **not implemented** — no host structure holds the value
- **not implemented** — outside R27c's four tasks

### `plans/2026-07-29-subagent-frontmatter.md`

- **not implemented** — scope parsed, validated and carried; the per-agent memory DIRECTORY (
- **not implemented** — the frontmatter parser is typed
- **not implemented** — no per-subagent hook scope, and the value is a nested event map the flat frontmatter parser cannot represent
- **not implemented** — no main-session-agent surface (

### `plans/2026-07-30-approval-path-truth.md`

- **not implemented** — hooks.md:1711 makes echoing a received suggestion equivalent to the user picking that always-allow option. Suggestions are offered only for a Bash prefix rule and a bare MCP tool rule; a curl or wget domain whitelist and a file-write tool-plus-path hash have no documented rule spelling, and none is invented:
- **not implemented** — hooks.md:1904 gives PermissionDenied a tool_use_id alongside tool_name, tool_input and reason. The band fires the event with the other three; the tool call id is not threaded to that site, so a hook correlating a denial to its originating tool call cannot:

### `plans/2026-07-30-false-surfaces.md`

- **not implemented** — Monitor's availability rule that setting DISABLE_TELEMETRY or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC removes the tool has no reader in this repo: neither variable is consulted anywhere, so an operator who sets them to keep a host quiet still gets command and ws watches; the ws field rules beside that sentence are enforced, this availability gate is what remains

### `plans/2026-07-30-hook-runtime-contract.md`

- **not implemented** — hooks.md filters ConfigChange on the settings source that changed and exit 2 blocks the change; all three adapters accept the event, but Nessy emits it only with runtime session-config keys, so no settings-file edit ever produces an occurrence and the documented tamper-detection mechanism has no settings-file producer; its own plan comes next:
- **not implemented** — hooks.md gives asyncRewake a wake half: the background command hook runs and the field is recorded, but the wake-on-exit-2 idle-session mechanism is still deferred, so a long-running background failure never re-enters the loop:
- **not implemented** — the managed level of the hook kill switch is parsed, enforced on plugin hook candidates and accepted by the pinned automation builder, but the live session assembly does not yet pass it, so on a running session the managed switch silences plugin hooks and not the native tiers until the locked call site adopts the option:
- **not implemented** — the lease service now aborts creation on a thrown, blocked or refused WorktreeCreate emit and a non-zero exit projects as a block, but the live Pi emit implementation still returns only the worktree path and discards the block, so a failing hook aborts nothing on a live session until the locked read site adopts the blocked channel:
- **not implemented** — hooks.md defaults shell form to bash, or to powershell on Windows without Git Bash, and honors a bash choice through Git Bash; Nessy keeps its platform default spawn when the field is absent, refuses a bash declaration on the PowerShell-only Windows runner, and the Pi host runner does not yet pass the field to the process builder:
- **not implemented** — hooks.md deduplicates HTTP hooks by URL; the imported http hook type now gets that key, while native webhook automation actions keep their authored delivery — two identical webhook actions still fire twice, an ours-ahead surface the documented rule was not stretched over:

### `plans/2026-07-30-hook-verdicts.md`

- **not implemented** — an http hook still POSTs whatever body its manifest declared, and the hook input JSON the page sends as the request body never reaches the endpoint. So a policy webhook now has a verdict channel and still no event to judge; the runner request carries no input to send:
- **not implemented** — UserPromptExpansion still fires once per turn at Pi agent start with no expanded command name, so its documented matcher matches nothing and only a matcherless hook reaches the new gate. The lifecycle bridge that emits it is owned by a sibling executor:
- **not implemented** — frontmatter hooks on a skill or subagent are refused with a diagnostic and a deferral instead of registering. Registration needs the component-lifetime scoping the page describes, and the Claude adapter half is locked to a sibling executor:

### `plans/2026-07-30-instructions-and-context-surface.md`

- **not implemented** — the documented suggestion set could name the custom-subagents row, and no suggestion does. The only per-capability enable control here is the Plugins page toggle, which reaches plugin-supplied subagents; a native markdown agent can be removed only by deleting its file, so the sentence would have no control to name:
- **not implemented** — an at-path import inside a NESTED instruction file is not resolved. Import materialization belongs to the eager inventory pass, which never reaches below the cwd, and the lazy channel delivers the bytes on disk; so an import line in a package's own instruction file reaches the model as literal text rather than as the file it names:

### `plans/2026-07-30-last-three.md`

- **not implemented** — sandboxing.md:176 re-opens paths inside a denied region, and the funnel and both backends implement it, but nothing in production ever passes the resolved allowRead list to the supervisor: an administrator who writes the key gets no read boundary and no refusal on the two platforms that cannot bind one:
- **not implemented** — sandboxing.md scopes the filesystem layer to every sandboxed command, and the script sandbox handler composes its own isolation from credentialDenyRoots without consulting the resolved sandbox settings, so the disable key reaches supervised processes and not that path:
- **not implemented** — sub-agents.md:1021 has the panel open a running fork and send it follow-up messages. The child transcript is now readable while it runs, but the runtime snapshot exposes no child session id, so nothing outside the host can correlate a fork with the session that carries its text:
- **not implemented** — permissions.md has a pending approval survive until it is answered. A renderer reload drops the in-memory prompt map and the host re-emits nothing, so a request still pending on the server renders no card and the session waits with no surface:
- **not implemented** — sub-agents.md:1043 surfaces a subagent prompt in the session the user watches. The runtime snapshot filters pendingPermissions by exact session id, so a fork prompt is absent from the parent snapshot and present only on the hidden child, and no read distinguishes a stale card from a second prompt:

### `plans/2026-07-30-managed-policy-honesty.md`

- **not implemented** — D4 makes the SessionManager capture live, and the capability resolver keeps its own construction-time managed capture. So a delivered deniedMcpServers reaches the channel gate and the permission readers without a restart, while the resolver's admission filter still applies the boot policy until the next launch:

### `plans/2026-07-30-managed-values-and-telemetry.md`

- **not implemented** — settings.md:311 defines the requiredMinimumVersion and requiredMaximumVersion pins and server-managed-settings delivers managed settings remotely, but both hosts enforce the pins from the host-owned policy file only, deliberately: a version gate readable from the delivered cache would let a poisoned cache refuse app startup, so remote delivery for the two pins is withheld by design:
- **not implemented** — monitoring-usage.md:442 has all metrics and events share standard attributes, session.id on by default per :446 and user.id always included per :452. Nessy usage-metric data points carry backend, model, type and cost_reporting only — a deliberate privacy-preserving narrowing for a bank fork: no per-user or per-session identifier leaves the operator's machine:
- **not implemented** — monitoring-usage.md:95 lists console, prometheus and otlp metrics exporter types. Nessy implements the otlp exporter and honors none as a hard disable; a selector naming console or prometheus creates no such exporter, and a list omitting otlp without saying none still exports over OTLP:
- **not implemented** — monitoring-usage.md:94 makes the telemetry opt-in required for collection and the usage-metrics exporter now enforces it, but the Pi OTLP log exporter in server-core src pi-harness otlp-telemetry.ts still starts off the ambient endpoint variable alone; the same gate and the :96 logs none disable are still to be applied there:

### `plans/2026-07-30-manifest-mode-and-aliases.md`

- **not implemented** — permissions.md:281 anchors a single-leading-slash path rule at the directory of the settings source that defines it, and :288 maps five scopes onto five directories. Nessy drops such a rule from every permission-rule layer, because the layer input carries no settings-source directory and compiling one without a root fails the whole layer closed:
- **not implemented** — auto-mode-config.md:246 gives the classifier three CLI subcommands: defaults prints the built-in rule lists as JSON, config prints the effective merged config, and reset removes the autoMode section from user settings. Nessy resolves those sets into the judge prompt and has no surface that prints or resets them:
- **not implemented** — tools-reference.md names tools Nessy has no counterpart for, and an imported Claude agent listing one in tools is rejected whole rather than losing that one tool, because the resolver throws on a name with no alias entry. The documented names that do have a Pi counterpart now resolve; Skill, EnterPlanMode, TaskOutput and the rest still throw:
- **not implemented** — permission-modes.md:240 makes useAutoModeDuringPlan a user setting that is on by default. Nessy reads it from the stored config and honours it in the plan-mode route, and it has a getter and setter beside the guardian settings, but no settings control and no RPC channel, so turning it off means editing config.json by hand:

### `plans/2026-07-30-mcp-surfaces.md`

- **not implemented** — mcp.md:147 lists headersHelper among the fields a ws entry accepts, and mcp.md:759 documents it for http and sse as well. Nessy has no dynamic header generator for any transport: the project-config reader parses the field, warns that it was ignored, and connects with the static headers only:
- **not implemented** — mcp.md:147 says a ws entry accepts headers and mcp.md:147 adds that authentication is header-only. The vendored SDK WebSocket transport takes a URL and nothing else, so a ws server's headers are parsed, carried on the config and named in a pool warning, but never sent:
- **not implemented** — mcp.md:322 lists WebSocket among a plugin's supported MCP transports. The project config now carries ws end to end, but plugin import still refuses it with a named diagnostic, because PluginMcpDescriptor cannot admit the value until the remote arm of SdkMcpServerConfigWithoutSecrets does, and that type lives in another executor's zone:
- **not implemented** — settings.md gives sandbox.network deniedDomains and allowManagedDomainsOnly, and the ws MCP guard consults both. The pool has no settings layer, so the values arrive only if its owner passes them, and no owner does yet; the literal-address and resolved-address clauses apply regardless:

### `plans/2026-07-30-mentions-and-skill-vars.md`

- **not implemented** — plugins-reference.md scopes a plugin bundle's placeholders to skill and agent content, and skills.md:309 names only the skill and project directories for the allowed-tools site. A plugin skill naming its bundle root in a restriction degrades to a literal that matches nothing and prompts; the skill-directory variable is the documented grant:
- **not implemented** — skills.md:267 says an unavailable model is not used and the session keeps its current one. A skill naming one still throws at grant application, so an unresolved variable in that field aborts the turn one hop later than it used to; only the two tool fields reach the documented literal degrade:
- **not implemented** — mcp.md:1150 calls resource paths fuzzy-searchable in the mention autocomplete. The mention trigger's character class stops at a colon, so typing a scheme closes the menu and a resource is reached by server, name or description rather than by typing its uri:
- **not implemented** — mcp.md:1116 offers resources from all connected MCP servers. The renderer caches one query's candidates and filters later keystrokes client-side exactly as it does for files, so deleting characters narrows against the cache instead of re-asking the host, and a server connecting mid-menu is not seen until the menu reopens:
- **not implemented** — skills.md:307 defines the project root for every skill origin. The child-session skill producer in SessionManager passes no host context at all, so a preloaded subagent skill gets no project dir, no session id and no effort level; that file was locked to another agent this run and the base agent producer is the only one fed:

### `plans/2026-07-30-pinned-block-repetition.md`

- **not implemented** — Codex is left re-sending because a permission-mode change tears its thread down and starts a new one with no history, and the teardown decision is taken after the turn was composed, so a once-sent block would be lost with no signal that it had been:
- **not implemented** — Claude is left re-sending because its four fresh-session recovery sites null the sdk session id inline instead of going through the one seam that forgets a delivered block, so the latch would go stale against an empty transcript. Provider is off by default at build time:

### `plans/2026-07-30-plugin-dependencies-and-monitors.md`

- **not implemented** — plugin bin directories are detected and deferred and must stay that way, because putting one on PATH lets any enabled plugin shadow git, ssh, sudo, node or bun by bare name for every subprocess the agent spawns, not only the Bash tool, and the per-capability trust record cannot represent a directory whose file set changes on update
- **not implemented** — dependency auto-install and semver range resolution both need plugin-name--vversion git tag enumeration on the marketplace repository, and no marketplace source in this repo enumerates tags at all; every source is a catalog-pinned ref, an npm package or a URL, so resolving a tilde range against whatever the catalog currently holds would make a constraint silently mean latest
- **not implemented** — range intersection across every installing plugin, and the range-conflict install failure it produces, exist to pick one version to FETCH; nothing is fetched here, so each dependent plugin's own range is checked independently at load and yields the same per-plugin verdict without the intersection
- **not implemented** — the cross-marketplace dependency refusal and its allowCrossMarketplaceDependenciesOn allowlist gate auto-install, so with nothing auto-installed there is no install to refuse; the target marketplace name is carried into the IR and already narrows which installed plugin can satisfy a dependency, so the check has its input the day auto-install lands
- **not implemented** — prune of orphaned auto-installed dependencies and the provenance bit it needs have no writer, because nothing is ever auto-installed; adding the bit now would ship a store field no code sets and a verb with nothing to remove, which is the declared-but-inert shape this audit is named after
- **impossible** — the enable-time refusal when a dependency is set to false at a scope with higher precedence than the target cannot be evaluated here, because precedence is narrowest-wins and a global or workspace target names no single narrower scope to read; Claude has one active workspace and project and Nessy has many, so picking one would refuse an enable that is legal in every other
- **not implemented** — the organization-plugin-policy row of the enable-failure table is a managed-policy read, and the managed policy is assembled in the server-core resolution inputs rather than in the store-only management service where transitive enable runs, so that one condition is unenforced while the other three are
- **not implemented** — a monitor whose when field is on-skill-invoke followed by a skill name is imported, reported as deferred and never started, because no skill-dispatch seam exists to observe the trigger; starting it at session start instead would run a monitor its author explicitly asked to hold back until a skill ran

### `plans/2026-07-30-plugin-rollout.md`

- **not implemented** — delivery registers the marketplace and never installs the plugin, so a mandated plugin still needs one install per workstation. The page puts installation behind explicit consent; what changed is that doctor now names an unfulfilled mandate instead of the no-op being silent:
- **not implemented** — a multiple-valued string option cannot be filled in from the configuration form at all: the input yields one scalar and the store requires an array, so the save is refused as invalid. Only a single-valued option is settable through the UI:

### `plans/2026-07-30-prompt-cache-and-egress-disclosure.md`

- **not implemented** — prompt-caching.md:28 keeps CLAUDE.md, auto memory and unscoped rules in a project-context layer that changes only at session start, compact or clear. Ours is composed onto every user message instead, so a 3736-token memory added 4331 tokens to each turn's conversation layer where an empty one added 750:
- **not implemented** — prompt-caching.md:198 auto-selects the cache TTL by auth type; ours stays one manual boolean. It only rewrites cache_control, which only the Anthropic adapter emits, and the shipped Pi and Nestor path is an OpenAI-like relay with automatic prefix caching and no cache writes, so auto-selection would bill and change nothing:
- **not implemented** — sandboxing.md:321 puts the per-domain boundary behind a proxy. R19 stays parked by owner decision, so deniedDomains and allowedDomains bind nothing for a sandboxed command; the settings page now names each such entry instead of the session log alone:
- **not implemented** — the egress posture rides the startup isolation probe, which is the only caller holding resolved sandbox settings. A standalone server answering the capability RPC on demand reports no posture, and the isolation section then states availability with nothing about egress:

### `plans/2026-07-30-reachable-surfaces.md`

- **not implemented** — settings.md:251 gives cleanupPeriodDays no disabled value at all, only a minimum of 1 and a validation error on 0, and names an env var for skipping transcript writes as the nearest thing. Nessy carries its own boolean off switch beside the window because a destructive sweep needs an off that means never, not a window nothing has aged past yet:
- **not implemented** — settings.md:251 puts the paused-sweep warning in /status. Nessy has no /status surface: the pause reaches the settings retention card and the nessy-general-agent doctor report, and a session that is already open is not re-notified when a settings file becomes unreadable mid-run:
- **not implemented** — monitoring-usage.md:105 defines OTEL_LOGS_EXPORT_INTERVAL with a 5000ms default. The Pi log exporter flushes on a queued microtask per batch and drains on shutdown, so there is no interval to configure and the variable is read by nothing:
- **not implemented** — monitoring-usage.md:96 lists console, otlp and none as logs exporter types. Nessy implements the otlp exporter and honors none as a hard disable; a selector naming console creates no such exporter, and a list omitting otlp without saying none still exports over OTLP:
- **not implemented** — elicitation.md:408 asks clients to provide manual controls to retry or cancel the original request when a completion notification never arrives. Nessy waits five minutes, then rethrows the server error and leaves the retry to the model or the user re-issuing the tool call; there is no dedicated resume control:
- **not implemented** — plugins/components.md#themes-and-output-styles (was line 340 of the retired plugins-reference page) has plugin themes appear in /theme beside built-in presets, with :354's custom:<plugin-name>:<slug> selection and a read-only copy-to-edit path. A plugin theme's base preset and terminal color tokens have no defined mapping onto the Nessy web theme token set, so the declaration is refused with a dia

### `plans/2026-07-30-read-side-exposure.md`

- **not implemented** — a read allowlist resolves from settings, reports in the doctor and binds in the darwin profile, and no host passes it to the supervisor yet. The supervisor option exists; the one line that fills it lives in SessionManager, which is locked to a sibling executor this session:
- **not implemented** — linux and win32 REFUSE every supervised spawn when an allowlist is configured, rather than enforcing one. bwrap starts from a whole-root read bind, firejail whitelists writes, and the Windows profile has one value per path with no re-allow. A refusal is loud; it is not the feature:
- **not implemented** — the doctor prints an unenforceable allowlist with a marker and still exits zero, unlike an unenforceable domain rule. The predicate that would change it sits beside a section a sibling executor committed to twice today:

### `plans/2026-07-30-record-and-floor.md`

- **not implemented** — a removal nested inside ANOTHER interpreter's quoted argument is not reached. powershell -Command "Remove-Item -Recurse -Force $HOME" and cmd /c rd /s /q %USERPROFILE% both hide the removal in one quoted token, and neither scan descends into one. The wrapper stripper, not the breaker, is where that would be fixed:
- **not implemented** — the /subtask START announcement is still a transient info event, so a reloaded transcript carries the fork's result and not its beginning. The result entry names the fork's task so it reads on its own; persisting the announcement as well would mean string-matching an info message, which is the seam this wave keeps removing:

### `plans/2026-07-30-sandbox-mach-and-protected-paths.md`

- **not implemented** — com.apple.trustd is the system-scope endpoint of the same daemon as com.apple.trustd.agent, and the case that needs it, validating a chain that terminates in the system trust store, cannot be probed without reaching an external host, so it is kept on documented need rather than proven by a run
- **not implemented** — buildMacosBashSeatbeltProfile returns allow default while SEATBELT_TESTING_WILDCARD is true, so its filtered rule denies nothing until the pre-GA flip; the session-tools-core profile has no wildcard branch, and it is the one the supervised-process isolation and script_sandbox compose, so there the narrowing binds now
- **not implemented** — com.apple.SecurityServer stays denied, probe-confirmed against a nonexistent keychain item, so a keychain credential helper such as git credential-osxkeychain fails inside these profiles; the bare grant permitted it, and granting it back would defeat the credential deny roots this package already emits
- **inapplicable** — mach is a darwin concept with no counterpart elsewhere: bubblewrap and firejail confine the mount namespace and expose no name-based IPC broker, and the Windows profile has no IPC section, so a D-Bus socket is reached only through the filesystem the mount policy already governs
- **not implemented** — the floor covers the file-write tools only, since the documented mechanism is a file-write prompt; a shell redirect into a protected path is governed by the sandbox deny roots in isolation/self-config-deny.ts, which name the config directories but not the shell rcs, the wrapper properties or .npmrc
- **not implemented** — permission-modes.md:527 second half offers Yes, and allow Claude to edit its own settings for this session, which approves later .claude writes without asking again; this floor carries no don't-ask-again at all, so it is stricter than the page and closing it needs a session-scoped grant channel
- **inapplicable** — permission-modes.md:522 gives plan three outcomes and this floor always takes the third, a prompt, which is the strictest; both conditional ones now have session state behind them (bypassPermissionsAvailable and getUseAutoModeDuringPlan) but neither is read here, because planClassifierEligible admits only the removal breaker's classifier-adjudicated prompt

### `plans/2026-07-30-subprocess-contracts.md`

- **not implemented** — clients MUST ignore notifications referencing unknown or already-completed IDs and MAY use them to auto-retry, but NessyMcpClient in packages/shared/src/mcp/client.ts registers no notifications/elicitation/complete handler; the vendored MCP SDK 1.29.0 ships ElicitationCompleteNotificationSchema with no Nessy consumer. Host-side, outside this subprocess unit.
- **not implemented** — a URLElicitationRequiredError names the elicitations to complete before the original request can be retried, but no Nessy code catches code -32042 or retries the original request; the catch belongs at the host MCP response path in packages/shared/src/mcp/client.ts and elicitation.ts, and SDK 1.29.0 already defines ErrorCode.UrlElicitationRequired unconsumed.

### `plans/2026-07-30-switches-and-sandbox-key.md`

- **not implemented** — sandboxing.md:478 turns the settings-file deny rules off with the filesystem layer. The key now parses, resolves and reports exactly what it surrenders, but resolveProcessIsolation still composes selfConfigDenyWriteRoots unconditionally, so the layer is described as off while every deny root still binds:
- **not implemented** — env-vars.md:318 names custom themes, custom keybindings, the status line and file-suggestion commands among the surfaces safe mode must not load. Nessy has no third-party loader for any of the four: they are not capability kinds, so the single gate suppresses nothing there and the doc line is only partly met:
- **not implemented** — settings.md:260 keeps built-in commands typable while hiding them from the model when bundled skills are off. Nessy removes the bundled skills and the workflows and stops there: no command is hidden from the model, and the managed policy key list carries no row for the setting, so an organization cannot enforce it:
- **not implemented** — env-vars.md:307 caps the wait that non-interactive mode takes after the final turn. The cap and the wait now exist for nessy-general-agent run, which sets the marker the agent subprocess reads, but no other entry point sets it, and the separate five-second grace period for plain background shells is absent:

### `plans/2026-07-30-tool-search.md`

- **not implemented** — Claude defers every MCP tool by default and ours stays off, because Claude's default is safe only where tool NAMES remain in context while the schemas leave, and we list neither names nor server instructions once deferral is on. Flipping the boolean alone would hide the catalogue from the model instead of shrinking it, so the name listing has to land first.
- **not implemented** — the tool names Claude keeps in context when schemas are deferred, plus the MCP server instructions beside them. Not a subprocess tweak: a name-only placeholder is projected back to full size, because projectPiToolDefinition rebuilds a dynamic tool from the manifest modelSchema and not from the runtime definition, so it needs a manifest change and its own slice.
- **not implemented** — an informative refusal when the model calls a deferred tool by name. Pi answers Tool X not found from its own loop, and that branch returns before beforeToolCall, so no host hook can name the deferral. The only interception seam is a registered definition, which is the name listing above. Search output plus the load tool guidance is the whole mitigation today.
- **impossible** — the false value cannot switch discovery off for a desired MCP server holding no cached descriptors. Claude reaches such a server with WaitForMcpServers instead and we ship none, so obeying false there would delete the only route to those tools and report nothing. The override governs the preference and the threshold; this floor stays unconditional.
- **inapplicable** — every platform fallback on the tool-search page, including CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS and the non-first-party base-URL rule that would otherwise cover the Nessy Gateway. Each exists because Claude tool search is an API beta carrying defer_loading and tool_reference blocks; ours is two ordinary tools over a host catalogue, so no header exists to strip.
- **not implemented** — the startup block alwaysLoad also imposes, capped at five seconds, so a pinned server's tools are present when the first prompt is built. Ours pins a server out of deferral and nothing more. That is a connect-timing property of a non-blocking MCP startup rather than a loading one, so it belongs with MCP connection work and not here.

### `plans/2026-07-31-claude-mode-vocabulary.md`

- **not implemented** — Claude's acceptEdits auto-approves a filesystem set including rm and rmdir and tolerates env-prefixed and wrapper spellings; ours keeps the non-destructive subset with no env-prefix or wrapper acceptance, by bank decision, so a deletion or a wrapped command still prompts
- **not implemented** — Claude's auto mode routes protected-path writes to the classifier; our protected-path floor keeps the deny for dontAsk and a non-negotiable human prompt in every prompting mode, with bypassPermissions the only escape, so a protected write is never delegated to a model judge
- **not implemented** — Claude's plan mode exits on plan approval; ours stays persistent — accepting a plan transitions the session through one deliberate clamped force-set and re-entry is explicit, so a session never silently leaves plan merely because a plan was approved
- **not implemented** — Explore is our seventh permission mode with no Claude counterpart: read-only exploration that grants scoped writes to the session plans and data folders only, incomparable with plan on the write axis, kept as the ONE documented extension to Claude's six-mode vocabulary

### `plans/2026-07-31-fork-permission-hang.md`

- **not implemented** — the snapshot widening is one level deep. A grandchild's prompt surfaces on its own hidden parent and not on the root session, while the event routing walks all the way to the root, so the two surfaces disagree for a nested subagent:

### `plans/2026-07-31-install-and-revoked-lease.md`

- **not implemented** — derived npm coordinates are a coordinate guess and never a publisher claim: 114 of the 116 distinct derivations resolve against the real Artifactory and the 2 that do not were never published, so a row whose package is absent now fails at download rather than at listing; the registry, not the derivation, stays the authority on existence
- **not implemented** — a catalog row that states an install command this app cannot parse is refused rather than derived from, so only rows carrying no install field at all reach the derivation; a row that made a claim is never second-guessed, which keeps the 12 published commands and any future unusable one on the clean refusal
- **not implemented** — the installed record's provenance keeps the marketplace's advertised version rather than the one the registry served, so a repair or update re-widens to the newest build stamp of that base instead of reproducing the exact artifact first installed, and no integrity digest is persisted from the resolved dist either
- **not implemented** — a version pinned with its own prerelease widens only to a build stamp of exactly that prerelease, so a row advertising a prerelease that was superseded rather than stamped still refuses instead of moving to the next prerelease of the same base; crossing prereleases would be the substitution the rule exists to prevent
- **not implemented** — the send path's own materialization stays unguarded on purpose: a pinned turn snapshot that is genuinely revoked fails the turn rather than running it with no MCP servers at all, which would be a silent capability loss dressed as success; only the observing preflight degrades
- **not implemented** — source credential closures handed to the pool capture the turn's materializer and outlive its lease, so an api source's token getter invoked after the turn ends meets a released lease and nothing re-enters the resolver to clear it; confirmed by reading the seam, distinct from the measured failure, and handed back for its own row
- **not implemented** — a plugin-scoped invalidation revokes every live lease in every workspace because instance membership is not resolved there, which is deliberate fail-closed behaviour and was left alone; it did not amplify the measured failure, whose throw came from the credential branch and never reached the lease check
- **not implemented** — the live after for the send fix is owed because the change is main-process only: Vite HMR cannot deliver it to the running rig, so proving it needs a rebuilt main bundle and an owner relaunch, and the seam is proven by unit instead

### `plans/2026-07-31-mode-table-and-labels.md`

- **not implemented** — auto mode still auto-approves file writes with no root bound: shouldPromptInAutoMode gets autoAllowFileWrites without autoAllowWriteRoots and the roots check approves when no roots are given, where Claude bounds write auto-approval to the working directory; deliberately deferred Option B material — this plan only stopped a trusted project from reaching auto over a stricter floor
- **not implemented** — parsePermissionMode and mapClaudeModeToPermissionMode keep disjoint alias sets: the first accepts explore, execute, ask-to-edit and accept-edits spellings, the second accepts Claude's default, manual and bypassPermissions; left disjoint because each feeds a different surface (user-facing mode strings vs a PermissionRequest hook's setMode) and unifying them is naming policy, not a defect fix
- **not implemented** — the Nestor cloud composer mode options keep hard-coded English labels (Plan, Act, and the agent-card title fallback) instead of i18n keys; left as-is because remote-supplied labels are the provider's contract surface and the label single-sourcing was scoped to the local seven-mode catalog, away from the nestor-cloud boundary

### `plans/2026-07-31-plugin-install-usability.md`

- **not implemented** — Claude keeps one credential per server centrally with no per-workspace scoping anywhere in the contract; our connector credentials are global per owner decision 0b-1, but a workspace-scoped disable or uninstall purge still clears the SHARED slot, so one workspace's cleanup signs every workspace out of that server — conservative, never grants, accepted until the option-C credential rework
- **not implemented** — Codex's policy.authentication lets a catalog demand install-time auth for any connector; our wire authRequests stays ON_INSTALL-only by owner decision 0b-2 (Claude's no-chaining model), so an ON_FIRST_USE connector never gets install-time OAuth even when a marketplace policy asks for it — sign-in moves to the session-start notice
- **not implemented** — the stdio-connector demotion died at the manifest funnel per owner decision 0b-3, yet resolveConnectorSourceRuntime keeps its stdio branch for entries installed before T9; pre-T9 installs stay on the parked path until reinstall or the option-C migration, so the dead class outlives its producer in old stores
- **not implemented** — Codex app-only connectors (.app.json bindings with no materializable MCP server) surface only as the unsupported-app auth requirement row; no card, page or notice names them beyond that, and whether they deserve a first-class surface is deferred to the option-C plan
- **not implemented** — Claude connects every .mcp.json server kind, while the T1 promotion gives the Source/OAuth path only to oauth-declaring http and sse entries; ws entries and header- or env-authenticated remotes keep capability semantics with no OAuth slot — the measured pre-T1 behaviour — until option C unifies the path
- **not implemented** — Claude signs into a pending MCP server per server via /mcp or claude mcp login; our dp-backed servers share ONE system login (ensureGatewayAuth plus a value-only broker probe), so the checklist and the notice offer a single dp sign-in that unblocks all nine servers at once — deliberate: dp is a system credential, not a connector OAuth
- **not implemented** — the plan's 9b read the awaitConnect seam as the flip point, but awaitConnect true at send would re-introduce the measured 33.7s turn-latency scaling and let one hanging server block the turn; connect-at-session-start is instead a policy-gated warm of the shared workspace pool at createSession, and the send path keeps awaitConnect false in BOTH policy states
- **not implemented** — Claude connects the servers of enabled plugins at session startup regardless of session shape; our session-start connect is workspace-scope only and skips ephemeral helper sessions, so trusted-project-scoped MCP still connects at first send rather than at create — a deliberate containment of the T10 blast radius

### `plans/2026-07-31-plugin-mcp-capability-path.md`

- **not implemented** — the server-owned OAuth prepare path still omits the
- **not implemented** — ADR § 2 has the migration purge a global connector row whose pluginKey has no active install (revoke before freeing the slot); the C4 migration SKIPS such rows instead, because the execution plan's iron rule ("the migration never deletes or overwrites a
- **not implemented** — the catalog-authenticated promotion (
- **not implemented** — the § 7 renderer residue (SourcesListPanel's connector-source enablement path, SourcesManagementRow's connector kind, capability-info-metadata's connector rows) and the inert
- **inapplicable** — ADR § 8's "flag off = the Source projection runs exactly as before" ended WITH C5 by design: the projection code is deleted, so
- **not implemented** — a flag-ON legacy-connector projection derives a NEW capability trust hash (the deleted connector-source grant keyed
- **not implemented** — the C2 trigger tool's plugin-server branch has no silent-refresh fast path (the source branch refreshes before raising an auth card); the pool's read-through refresh keeps slots fresh at materialization, so the only cost is an occasional avoidable auth card from an explicit model-initiated trigger. Open close-out items (planner-driven, per the dispatch): version bump + release notes + doc

### `plans/2026-08-11-mcp-followups-f2-f4.md`

- **not implemented** — a plugin author whose hook declaration is malformed, or whose once or asyncRewake field is ignored, receives no message at all and the hook is simply inert, which is the one failure mode an author cannot diagnose from outside the app.
- **not implemented** — a plugin manifest asking to install disabled is honoured as far as the store and then ignored at activation, so an author who ships opt-in gets the opposite of what the manifest requested and no test covers the gap.
- **not implemented** — the wire name a permission rule must be written against is never rendered in the app, so a user told to rewrite a rule against the generated name can obtain it only by making the server run a tool and reading the name out of the tool name in the transcript or a permission prompt.
- **not implemented** — the release notes promise that a stood-down server's row names the plugin skills that went inert with it, but the install-path normalizer strips the skill fields the resolver's inert-parts scan reads, so the promised list stays empty for every real installed plugin while every offline test passes.
- **not implemented** — codex asks this client for chatgpt auth tokens or an attestation token, whose response schemas require credential values, and receives an empty object by decision, because any well-formed answer would be a fabricated credential.
- **not implemented** — the headless codex path auto-approves a sandbox-widening permissions request at turn scope the way it auto-approves every unattended approval, which is the one place the unattended posture is broader in kind than a single action, bounded by granting only what was asked for one turn.

### `plans/2026-08-12-audit-defect-closure.md`

- **not implemented** — the codex runtime writes trust_level trusted into its own managed config for the session's directory, so the upstream first-run trust gate never asks, and a user who chose to keep a project restricted seconds earlier is silently overridden.
- **inapplicable** — the Codex plugin format has no agents component at all: its manifest points only at skills, mcpServers, hooks and the compatibility apps field, and agents/openai.yaml is a fourth manifest location carrying an interface block rather than agent definitions, so a Nessy agent reaches a Codex session through the config's own agents role blocks instead of through a plugin bundle.

### `plans/2026-08-12-sandbox-default-off-and-bypass-cli-parity.md`

- **not implemented** — the OS wrap layer ships disabled by owner decision 2026-08-12; parity, not a gap, since settings.md's own default is false; a managed policy wins in either direction over
- **not implemented** — the codex runtime's own sandbox mode follows the master switch while its approval policy is left untouched, so blueprint section 12's gate stays Nessy-side, in
- **inapplicable** — it runs untrusted snippets, its network isolation is why it needs no prompt, it fails closed, and it was never the instability the switch removes; see
- **not implemented** — auto's risky band treats only the administrator's excluded patterns as escapes, false while the switch is off; DOWNGRADED after checking the contract 2026-08-13: permissions.md says the built-in read-only set runs without a prompt in EVERY mode, sandbox or not, so the auto-approval this band leaves in place is the documented behaviour and not a divergence; not re-calibrated on purpose, named in th

### `plans/2026-08-17-claude-live-session.md`

- **impossible** — the working directory, the system prompt, the tool set, the subagent set and user hooks cannot be changed on a running session. Verified against the whole SDK type file twice, most recently after a hand-written count of the live setters had already proved wrong. Changing any of the five respawns the child, which is why they stay in the session signature —
- **impossible** — the explore permission mode has no SDK equivalent and stays ours on top of theirs, permanently. It is mapped onto the options where the existing mapping already put it; a second mapping is how the two would drift —
- **impossible** — the permission bypass is decided when the process starts, in the shipped CLI's own refusal wording, so crossing that boundary is real construction drift and the flag stays hashed into the respawn signature —
- **not implemented** — the SDK native message queue. Its rank field works and all three values were measured on the shipped CLI, but our writer cannot use it: every write happens with a turn slot just opened, so a second write earns a second result that must settle a slot nobody opened, and the reader may not start a turn from inside its own drain loop —
- **not implemented** — the two Claude background-work control levers, both present in the installed SDK and called from nowhere in this repo. Stopping a task needs a vertical slice down to the renderer; auto-backgrounding a foreground tool needs the policy that already exists for Pi to be reused rather than reinvented —
- **not implemented** — Claude background tasks do not reach the Background Tasks list. The level signal carrying them has replace semantics and our event model has no shape for it, so surfacing them is a shared wire change. They are announced in the transcript and now keep their session alive, so the work is no longer destroyed, only invisible —
- **not implemented** — a time bound on an open turn slot. A turn settles on its result or on session death, and under message coalescing neither arrives, so a folded turn would wait indefinitely. Harmless while exactly one message per turn is written, and a precondition of ever writing two —
- **not implemented** — the origin stamp on a streamed user message. The typings put an explicit obligation on a host wrapping keyboard input, we do not stamp it, and what being unattributed costs at the strict trust gates was not measured. Recorded as an obligation, not asserted as a defect —

### `plans/2026-08-20-cross-runtime-history-carry.md`

- **not implemented** — the raw field keeps the display field's 200 000-char cap, because the converter's gain is the correct cwd, not unbounded length."* Files:
- **not implemented** — a > trimmed native history reads to the model as complete. It sees a file's read > result with none of the turns that explain why, and nothing marks the gap. The > text handoff is honest by construction:
- **not implemented** — the app-server accepts them but writes
- **not implemented** — no evidence the vendor round-trips a synthesized image block, and our own code records that the Read tool cannot open an image. The loss is real and P3's

### `specs/2026-07-25-nessy-claude-parity-audit.md`

- **impossible** — <equivalent shipped>
- **impossible** — <Pi equivalent shipped>
- **not implemented** — requires /loop
- **not implemented** — subagents, conversation forks and workflows already cover the delegation scenarios agent teams address, and the part teams add on top is a shared-state model (a claimable task list plus per-agent mailboxes across full peer sessions) that Nessy does not have and would have to grow whole. Owner decision 2026-07-29 after the row's own framing was put to them: the first step is a judgement call, not a

### `specs/2026-08-02-claude-doc-sweep-divergences.md`

- **not implemented** — Nessy has no --init/--maintenance launch mode". Shipped code carries the same reason at packages/shared/src/plugins/hooks-automation.ts:347 (MATCHER_INERT_AGENT_EVENTS) and emits a registration-time
- **not implemented** — a settings key we do not carry
- **not implemented** — the documented default 'true' is conditioned on 'sandbox.enabled', an opt-in Nessy has no analogue of: supervised-process isolation here is unconditional, so porting the default verbatim would auto-approve EVERY Bash command. Honouring the key needs the opt-in surface it hangs off plus the four carve-outs at sandboxing.md:124–:127 … A settable-but-unread key would be the exact "declared on one pat
- **not implemented** — ... the per-agent memory DIRECTORY (agent-memory/<name>/, MEMORY.md injection, auto Read/Write/Edit) is a subsystem we do not have' (commit b31d6421), harvested into the deviation register at :306, and the parity audit's R30c row (2026-07-25 audit:698) says the same: 'costed with categories and NOT half-built'. Costed-and-deferred is an open gap, not a decision to keep it.
- **not implemented** — no env-file preamble is sourced before Bash tool calls, so the direnv recipe’s SessionStart and CwdChanged hooks run and their writes are never read', and specs/2026-07-26-r-queue-doc-verification.md:463 calls it 'an environment-injection channel with no equivalent on our side'. Crucially this row is NOT marked 'Kept deliberately' — the sibling row at :598 on the same list is, which shows the plan
- **not implemented** — requires /loop, which is not in this slice
- **not implemented** — no main-session-agent surface (

### `specs/2026-08-02-claude-doc-sweep-worklist.md`

- **not implemented** — MAX_CONSECUTIVE_HOOK_BLOCKS is a fixed 8 with no env override
- **not implemented** — a settings key we do not carry
- **not implemented** — a settings key we do not carry'. It stops being true the moment the key exists: either implement the
- **not implemented** — requires /loop, which is not in this slice" and costs the follow-up at four tasks. - Пользователь. None observable today. A user cannot reach the missing mechanism at all: there is no
