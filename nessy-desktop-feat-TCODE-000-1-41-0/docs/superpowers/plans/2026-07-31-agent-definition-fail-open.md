# One malformed agent file must not brick every session

**Measured live 2026-07-31 on the dev rig, by accident and at full cost:** an
agent definition at `~/.nessy-agent/agents/cdp-high-effort.md` carrying
`tools: []` made **every send in every session** die in ~220 ms with a
logged-as-`{}` error. Eight wave cases failed on this single cause. The throw:

```
Error: Invalid piRuntimeAgentDefinitions[0].tools: expected at least one tool
    at parseTools → parsePiRuntimeAgentDefinitions
    → materializePiRuntimeAgentDefinitions
    → SessionManager.getOrCreateAgentUnchecked → sendMessage
```

**The contract to match** (`sub-agents.md` — curl and quote the whole lines
before writing code): Claude treats a malformed subagent definition as that
agent's problem, not the session's — the skills loader in this repo already
follows the same philosophy (lenient parse, invalid = skipped + diagnosed,
`skill_validate` strict on demand). Our materializer instead fails the WHOLE
list on the first bad entry, at send time, with no surface naming the file.

## Tracker

| # | task | status | commit | note |
|---|---|---|---|---|
| A1 | A bad agent definition is skipped and diagnosed, never session-fatal | ✅ | 04ab19b2 | Per-entry everywhere: `materializePiRuntimeAgentDefinitions` builds each descriptor in try/catch and EXCLUDES a bad one via new `onInvalidDefinition` (agentKey/agentName/file/reason; file = absolutePath for native, pluginInstanceId/relativePath for plugin), and `parsePiRuntimeAgentDefinitions` gained the same per-entry `onInvalid` (tampered sha256/digest/duplicate-key entries are excluded fail-closed, list-level malformation still throws). Empty-tools DECISION: inherit — sub-agents.md:279 "Inherits every tool available to subagents if omitted. If no entry in the list resolves to a tool, the subagent usually fails to launch … with an error naming the entries" — the refusal is scoped to entries that fail to resolve, an empty list has none, so `tools: []`/`disallowedTools: []`/`skills: []` parse as omitted at frontmatter, descriptor and wire levels (digest-symmetric). Reachable surface: `nessy-general-agent doctor` gained an "Agent definitions" section (new `validatePiRuntimeAgentDefinitionContent` — same builder code as the send path, references shape-checked only; `collectAgentDefinitionFindings` scans CONFIG_DIR/agents; JSON `invalidAgentDefinitions`; hasFindings→exit 1), asserted in `apps/cli/src/doctor.test.ts` incl. real scan of a temp dir; runtime channel = sessionLog.warn `[capability-diagnostics] agent definition skipped: <file> — <reason>` at all 3 SessionManager sites + debugLog at pi-agent-server ingress. No `agent_validate` verb exists (only `skill_validate`); the validator IS the strict half. Red→green: empty-tools test red with the exact measured throw (`Invalid piRuntimeAgentDefinitions[0].tools: expected at least one tool` at parseTools→parse→materialize), A1 gate test (valid loads, malformed named) red before the lenient loop → 42/0 across the 4 focused files after. Mutation both sides: first-entry throw restored in materialize → A1 gate + 4 exclusion tests red; empty-throw restored in parseTools → inherit test red (wire-level assertion added when the first probe run showed that branch uncovered). typecheck:all 0, apps/cli 0, lint:shared 0; orchestration suite 26/2 — the 2 are the known-failing "retains … authority" rows |

## A1

**Commit:** `fix(agents): a malformed agent definition is skipped and named, not session-fatal`

- `parsePiRuntimeAgentDefinitions` collects per-entry failures instead of
  throwing on the first: a valid entry loads, an invalid one is EXCLUDED with a
  diagnostic that names the file and the reason, on the channel doctor/capability
  diagnostics already use. The turn proceeds with the surviving definitions.
- Decide `tools: []` semantics deliberately against the doc: if Claude treats an
  empty/omitted `tools` as "inherit all", parse it that way rather than
  refusing; if the doc refuses it, keep refusing — but per-entry.
- The diagnostic must be REACHABLE: assert it appears where a user can see it
  (doctor output at minimum), not only in a debug stream.

**Gate:** with one malformed agent file present (the measured `tools: []`
shape), a send completes and the diagnostic names the file; with all files
valid, behaviour is byte-identical; `agent_validate`-style strictness (if a
validate verb exists) still refuses loudly. **Mutation:** restore the
first-entry throw → the send-with-bad-file test goes red.

## Rules

Repo root tests; ps-check before every run; pathspec on the commit; no
push/MR/tags/reset/rebase/amend; probes by re-edit; specs/ and the CDP
checklist planner-owned; no version bumps; the app on 9224 is running a live
wave — do not touch it, and do not rebuild bundles until the wave notification
lands (the planner will rebuild at close-out). Code and commits in English.

## Report

Sha; the empty-tools decision with the doc line quoted; the send-with-bad-file
gate red-then-green; where the diagnostic surfaces; typecheck:all + apps/cli
exit 0; corrections.

## A2 — the second loader (appended 2026-07-31, from A1's correction c)

**Commit:** `fix(agents): the markdown agent-definition fallback loader is per-entry too`

`packages/shared/src/agents/definitions.ts:readMarkdownAgentDefinitionsFromDir`
is a SECOND loader with the same failure class A1 just removed:
`parseMarkdownAgentDefinition` throws uncaught per file, and
`normalizeExplicitStringList` still refuses `tools: []`. Production bypasses it
(closed-world runtimeDefinitions), but the Pi subprocess filesystem fallback
would die at subagent-spawn on one bad file. Same treatment: per-entry skip +
diagnostic naming the file, `tools: []` parses as omitted (the A1 decision,
sub-agents.md:279), and a test proving one bad file does not take the directory.

| # | task | status | commit | note |
|---|---|---|---|---|
| A2 | The markdown fallback loader is per-entry | ✅ | (this commit) | `readMarkdownAgentDefinitionsFromDir` catches per FILE: a malformed definition is skipped with `AgentDefinitionLoadFailure` (file + reason) through new `AgentDefinitionOptions.onInvalidDefinition` (threaded through `loadAgentDefinitions`/`readUserAgentDefinitions`, default trace via `debug()`), never directory-fatal. Empty lists align with A1: `normalizeExplicitStringList` parses `[]` (and the `''` shape `parseFrontmatter` delivers for a bare `key:`) as OMITTED — `tools: []` → toolset default, `disallowedTools`/`skills`/`mcpServers` `[]` → absent (sub-agents.md:279 quoted at the function); a malformed ENTRY still refuses that one definition. DOCTOR DECISION: yes for the global directory, no for workspace/project — the two loaders' parses diverge (fallback validates `toolset`; capability pipeline ignores it), so `collectAgentDefinitionFindings` now runs BOTH validators (new exported `validateMarkdownAgentDefinitionContent`, findings suffixed "(markdown fallback loader)"); workspace/project dirs stay out because doctor is session-free (debug-your-config.md:46 "without starting a session") with no workspace/trusted-project context. pi-agent-server untouched (W-executor territory; signatures additive-optional, `agent-defs.test.ts` green). Red→green: A2 gate test (bad `tier: huge` file skipped + named via `readUserAgentDefinitions` — reads only the temp dir, never the real config dir — valid sibling loads) and empty-as-omitted test both red on HEAD → 17/0, doctor 13/0. Mutation both sides: directory-fatal rethrow restored → A2 gate red (16/1); empty-list throw restored → empty-as-omitted red (16/1); reverted, final 46/0 across the 4 suites. typecheck:all exit 0 and apps/cli exit 0 (both re-verified with un-piped exit capture after a first run masked a real TS18048 in the new doctor test — fixed), lint:shared exit 0 |

## A3 — the JSON loader (appended 2026-07-31, from A2's residual)

**Commit:** `fix(agents): the JSON orchestrator-agents loader is per-entry too`

`readJsonAgentDefinitions` (config.json → `orchestratorAgents`) still throws
whole on a malformed file or a single bad entry — the same class, third
instance. Same treatment: per-entry skip + diagnostic through the same
`onInvalidDefinition` channel A2 threaded; a malformed FILE (unparseable JSON)
may still fail that file alone with a diagnostic, never beyond it; the A1
empty-list decision applies to any list fields it validates. Test: one bad
entry does not take the list; a valid sibling loads.

| # | task | status | commit | note |
|---|---|---|---|---|
| A3 | The JSON orchestrator-agents loader is per-entry | ✅ | 03236c76 | `readJsonAgentDefinitions` takes the A2 `onInvalidDefinition` channel (threaded from `readUserAgentDefinitions`/`loadAgentDefinitions`): an unreadable/unparseable config.json fails THAT FILE alone (diagnostic names config.json + the parse error; markdown siblings load; a JSON-null root no longer crashes via `raw?.`), and one bad `orchestratorAgents` entry is skipped with a diagnostic whose reason carries the `orchestratorAgents[i].field` label — fail-closed unchanged, the bad entry never loads. A missing `orchestratorAgents` key stays silent (config.json carries other settings). The A1 empty-list decision already applies to its list fields via A2's `normalizeExplicitStringList` (covered by the existing 'empty-json' test). DOCTOR DECISION: NO — the coordinator's "global" premise does not hold: the only read is `join(workspaceRootPath, 'config.json')` and no production caller passes a global path (orchestrator tools pass closed-world `runtimeDefinitions`; the one live filesystem caller, guardian-judge-core.ts:218, passes the WORKSPACE root), so the session-free doctor cannot resolve it — same debug-your-config.md:46 boundary that excluded workspace/project markdown dirs in A2; the skip surfaces through the callback/debug() channel. Red→green: all three rewritten/new tests red on HEAD (throw took the list/file) → 18/0, series-wide 49/0. Mutation both sides: list-fatal rethrow restored → 3 A3 tests red (15/3); file-fatal rethrow restored → A3 gate red (17/1); reverted. typecheck:all exit 0 (0 TS errors), apps/cli exit 0, lint:shared exit 0 (un-piped exit capture) |
