/**
 * The always-allowed read-only tool NAMES, in a module with no imports.
 *
 * ## Why the names moved here (P3.351, 2026-09-04)
 *
 * `ALWAYS_ALLOWED_TOOLS` is still the one Set every gate consults and it is
 * still exported from `mode-manager.ts`, built from this array — there is
 * exactly one copy of the names and it is this one.
 *
 * What changed is REACHABILITY. The Permissions page has to say which declared
 * `blockedTools` entries the runtime never consults, and the predicate that
 * decides it (`blocked-tools-enforcement.ts`) takes the always-allowed set as a
 * PARAMETER precisely so no second copy can hide in a renderer. But the
 * renderer could not obtain the real one: `mode-manager.ts` reaches 193
 * node-builtin import edges over 274 files (measured 2026-09-04), which is free
 * in a bun test and not free in a Vite renderer bundle.
 *
 * Two routes were open. A host-side classification passed down over a new IPC
 * channel — a wire surface, a preload entry, a handler and their tests, for a
 * list of eleven constant strings. Or this: lift the names, which have no
 * dependencies at all, into a leaf both sides can import. The second is
 * smaller, adds no wire, and keeps the single copy the predicate's docblock
 * requires, so it is the one taken. Recorded here rather than left to be
 * re-derived, because "why is this list not in mode-manager.ts" is the first
 * question a reader will ask.
 *
 * **Add a name HERE.** `mode-manager.ts` re-exports the Set unchanged, so every
 * existing reader is unaffected; the comments below travel with the names
 * because they document the names.
 */
export const ALWAYS_ALLOWED_TOOL_NAMES: readonly string[] = [
  'Read', 'Glob', 'Grep',           // File reading
  'Task',                           // Agent orchestration — 'TaskOutput' removed 2026-10-10 (UA12.211, SDK 0.3.280): the vendored Claude Code dropped the tool (sdk.d.ts: "the TaskOutput tool was removed"), so the entry allowed nothing on any runtime
  'WebFetch', 'WebSearch',          // Web research
  'TodoWrite',                      // Task tracking
  'SubmitPlan',                     // Plan submission
  // C3.153 (QJ12, 2026-09-11) — kept, NOT runtime-scoped, and the asymmetry is
  // written down because it is the advertised absence QJ12's decision (B)
  // created: on claude and codex this name is permission-listed with no tool
  // behind it. Measured at HEAD, and the null is wider than the row assumed —
  // no tracked producer of a tool NAMED `LSP` exists on any runtime here:
  // `session-tools-core/src/tool-defs.ts` scores 0 (controls in the same file:
  // `SubmitPlan` 7, `TodoWrite` 14 — LINES, `grep -c`, named because the other
  // instrument answers 10 and 17 on the same two needles and every BINARY probe
  // in this tree is occurrences; C3.294, re-measured 2026-09-12. A count of ZERO
  // is the one reading the instrument cannot change, which is why the finding
  // itself is safe and only its controls had to be re-taken), the vendored SDK's tool types score 0 in
  // both `sdk-tools.d.ts` and `sdk.d.ts` (control `Glob` 5, nonsense 0), the
  // pi-agent-server harness-contract tool surface scores 0 (controls
  // `SubmitPlan` 3, `TodoWrite` 3, `Read` 2), and across every tracked source
  // the quoted string `'LSP'` occurs in exactly one place: this line. Pi's
  // language server arrives as a plugin-declared `lspServers` entry
  // provisioned through the trusted-project owner, so whatever tool name it
  // publishes is the PLUGIN's, not this one — which is precisely the reading
  // QJ12's third row (an official `*-lsp` plugin in a trusted project) exists
  // to take, and until it runs this entry cannot be scoped honestly.
  //
  // Kept rather than deleted for one reason, stated so nobody re-litigates it
  // from the counts above: this is an ALLOW list, so an inert entry grants
  // nothing, while removing a name a future Pi LSP tool does use would turn a
  // read-only tool into one that prompts in safe/plan mode. Scoping it needs a
  // runtime parameter `ALWAYS_ALLOWED_TOOLS` does not have — a contract change
  // on the one Set every gate consults — for eleven constant strings. Both are
  // larger than the problem; the honest thing is to say what the name does and
  // does not mean, here, where a reader meets it.
  'LSP',                            // Language server (read-only)
  // `browser_tool` is deliberately NOT here: the browser tool is one
  // command-string tool whose verbs span reading a page AND clicking, typing,
  // navigating, and running arbitrary JS, so a name-level allow is wrong.
  // Canonical and `mcp__session__`-namespaced spellings both fall through to
  // the isBrowserToolNameOrAlias branch below — ONE decision site that reads
  // the command (chrome.md, "Browser tools in plan mode").
  // MCP resource read tools — readOnly / no-permission per spec. Listed here so
  // the proxy names (mcp__session__read_mcp_resource, ...) are allowed in
  // safe/plan mode via the `__<name>` suffix match, like TodoWrite. The deny
  // check above still runs first, so a `deny read_mcp_resource` rule is the lever.
  'read_mcp_resource', 'list_mcp_resources',
  // UB7.11 — the MCP prompt pair (upstream v0.15.1), same class as the resource
  // readers above: readOnly (`safeMode: 'allow'`, `readOnly: true` in tool-defs,
  // pinned Explore-safe there), the content is what a connected source serves,
  // and the resolution is the host closure. Listed so the proxy names
  // (mcp__session__source_list_prompts / source_get_prompt) are allowed in
  // safe/plan mode via the same suffix match; the deny check above still runs
  // first, so a deny rule remains the lever.
  // UB6.11 — the decide tool (upstream v0.15.1), same class as the readers
  // above: readOnly (`safeMode: 'allow'`, `readOnly: true` in tool-defs), it
  // writes nothing — the answer is advice the agent relays. The deny check
  // above still runs first.
  'decide',
  'source_list_prompts', 'source_get_prompt',
  // R17: reading a supporting file of a skill the session ALREADY invoked. The
  // bytes are served from the snapshot pinned by that invocation, so this
  // reveals nothing the eager emit did not already paste into the conversation
  // for free — it is strictly less powerful than `Read`, which is itself always
  // allowed. Listed here so the proxy name mcp__session__read_skill_resource is
  // allowed in safe/plan mode via the `__<name>` suffix match; a
  // `deny read_skill_resource` rule remains the lever, because the deny check
  // above still runs first.
  'read_skill_resource',
];
