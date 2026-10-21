# Nessy ↔ Claude Code parity — the whole picture

**Generated. Do not hand-edit.** Regenerate:

```bash
python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md
python3 scripts/build-parity-report.py --check   # report drift, write nothing
```

**Every number below is a snapshot of FIVE inputs, taken at their newest committed change, 2026-10-14.** The rule used to say "regenerate after any tracker change", which could not keep this file true: the tracker ([2026-07-25-nessy-claude-parity-audit.md](2026-07-25-nessy-claude-parity-audit.md)) is one input of five. The others are the deviation register ([2026-07-29-deviation-register.md](2026-07-29-deviation-register.md)), the corpus snapshot [`scripts/claude-doc-pages.tsv`](../../../scripts/claude-doc-pages.tsv) — which supplies the page denominator, so a corpus refresh moves §3 without anyone touching a row — and the FULL TEXT of every plan under `docs/superpowers/plans/`, read as a directory glob, because §3's page axis is harvested from the pages each plan cites — EVERY plan, since 2026-08-28: until then only the 55 of 134 that some tracker row happens to link were consumed, and fifteen pages a plan cites by full name read as cited by nobody. The fifth is the coverage map ([2026-07-31-claude-coverage-map.md](2026-07-31-claude-coverage-map.md)), read only to print §3a's crosswalk, so that this file and that one can no longer be quoted against each other. One consequence, measured 2026-08-25: this file goes stale on any plan commit, not only a tracker one. A second one is now FIXED rather than warned about — an untracked plan in the working tree used to land in the output (one such file moved §3b from 85 foreign names to 87) and, worse, to be counted by `--check`, which reported 8 differing lines on `feat/TCODE-000` where only 2 were real. Inputs are now taken from git's index, so both this file and its `--check` verdict describe the committed tree; anything skipped is named on stderr. The stamp above is the newest COMMIT date among those five inputs and never the clock, so a report regenerated on a later day is byte-identical — which is what lets CI reproduce this file from HEAD instead of reading a fresh date as drift. Run `--check` before trusting a count.

**143 of 150 rows are built** (134 matched, 9 where we are ahead of the documented behaviour). **7 are open.** Beyond the rows, **363 deviations** are recorded — documented behaviours we chose not to build, each with a written reason.

Detail is one link away by design: a row's commits, probes and every correction an executor made live in the tracker ([2026-07-25-nessy-claude-parity-audit.md](2026-07-25-nessy-claude-parity-audit.md)); a deviation's full reason lives in the plan that recorded it.

## 1. What we have

143 rows. The `plan` column links the plan that built it; a row without one was built directly from the tracker's own scope.

|  | ord | unit | behaviour | plan |
| --- | --- | --- | --- | --- |
| ✅ | 1 | R21 | Permission evaluation and modes | [manifest-mode-and-aliases](../plans/2026-07-30-manifest-mode-and-aliases.md) |
| ✅ | 1 | R22 | Plugin hook event coverage | [hook-runtime-contract](../plans/2026-07-30-hook-runtime-contract.md) |
| ✅ | 2 | R1 | Permission rule syntax and scopes | [manifest-mode-and-aliases](../plans/2026-07-30-manifest-mode-and-aliases.md) |
| ✅ | 2 | R15 | Permission evaluation and modes | [permission-request-band](../plans/2026-07-26-permission-request-band.md), [approval-path-truth](../plans/2026-07-30-approval-path-truth.md) |
| ✅ | 3 | R9 | Hook decisions on non-PreToolUse even…; Plugin hook event coverage | [hook-decision-patterns](../plans/2026-07-27-hook-decision-patterns.md), [hook-runtime-contract](../plans/2026-07-30-hook-runtime-contract.md) |
| ✅ | 4 | R3 | Reactive watching (Monitor) | [monitor-and-idle-wake](../plans/2026-07-27-monitor-and-idle-wake.md), [false-surfaces](../plans/2026-07-30-false-surfaces.md) |
| ✅ | 5 | R2 | Session worktrees | [session-worktrees](../plans/2026-07-27-session-worktrees.md), [approval-path-truth](../plans/2026-07-30-approval-path-truth.md) |
| ✅ | 5 | R12 | Checkpoint and session retention | [retention-and-checkpoint-gc](../plans/2026-07-27-retention-and-checkpoint-gc.md), [reachable-surfaces](../plans/2026-07-30-reachable-surfaces.md) |
| ✅ | 6 | R4 | Workflow persistence and governance | [workflow-recipes-and-governance](../plans/2026-07-27-workflow-recipes-and-governance.md) |
| ✅ | 6 | R5 | MCP resources and prompts | [mentions-and-skill-vars](../plans/2026-07-30-mentions-and-skill-vars.md) |
| ✅ | 6 | R8 | Compaction behavior | — |
| ✅ | 6 | R11 | Context window composition and /context | [context-composition-and-context-surface](../plans/2026-07-28-context-composition-and-context-surface.md), [false-surfaces](../plans/2026-07-30-false-surfaces.md) |
| ✅ | 7 | R6 | Session storage location and resume | [session-mirror-store](../plans/2026-07-28-session-mirror-store.md) |
| ✅ | 7 | R7 | Durable approvals and clarifying questions | [durable-approvals-and-questions](../plans/2026-07-28-durable-approvals-and-questions.md) |
| ✅ | 8 | R10 | Auto-backgrounding long work | [auto-backgrounding](../plans/2026-07-28-auto-backgrounding.md) |
| ✅ | 8 | R18 | Turn-level structured output | [structured-output](../plans/2026-07-28-structured-output.md), [subprocess-contracts](../plans/2026-07-30-subprocess-contracts.md) |
| ✅ | 8 | R20 | Task tracking tools | [task-tools](../plans/2026-07-28-task-tools.md) |
| ✅ | 9 | R17 | Skill file contract and disclosure | [false-surfaces](../plans/2026-07-30-false-surfaces.md), [mentions-and-skill-vars](../plans/2026-07-30-mentions-and-skill-vars.md), [skill-resources](../plans/2026-07-28-skill-resources.md) |
| ✅ | 9 | R24 | widens MCP resources and prompts | [reachable-surfaces](../plans/2026-07-30-reachable-surfaces.md), [mcp-elicitation](../plans/2026-07-28-mcp-elicitation.md) |
| ✅ | 9 | R25 | Server-managed settings — central org configuration delivered by a server rathe… | [delivered-policy-enforcement](../plans/2026-07-29-delivered-policy-enforcement.md), [managed-values-and-telemetry](../plans/2026-07-30-managed-values-and-telemetry.md), [managed-policy-tolerance](../plans/2026-07-28-managed-policy-tolerance.md) |
| ✅ | 9 | R26 | — (enterprise transport) | [managed-values-and-telemetry](../plans/2026-07-30-managed-values-and-telemetry.md), [server-managed-delivery](../plans/2026-07-28-server-managed-delivery.md) |
| ✅ | 9 | R27 | — (product surfaces) | [manifest-mode-and-aliases](../plans/2026-07-30-manifest-mode-and-aliases.md), [model-invocable-delivery](../plans/2026-07-28-model-invocable-delivery.md) |
| ✅ | 9 | R28 | Instruction rules tier | [rules-tier](../plans/2026-07-28-rules-tier.md), [adapter-collisions](../plans/2026-07-30-adapter-collisions.md) |
| ✅ | 9 | R30 | widens Skill file contract and disclosure, Subagent definition and inheritance | [false-surfaces](../plans/2026-07-30-false-surfaces.md), [skill-frontmatter-remainder](../plans/2026-07-28-skill-frontmatter-remainder.md) |
| ✅ | 10 | R23 | — (new subsystem) | — |
| ✅ | 10 | R29 | widens Subagent definition and inheritance | [fork-subagents](../plans/2026-07-29-fork-subagents.md), [session-command-seam](../plans/2026-07-30-session-command-seam.md), [fork-panel-registration](../plans/2026-07-30-fork-panel-registration.md) |
| ✅ | 11 | B1 | Marketplace schema and lifecycle; Plugin manifest and component paths | [plugin-path-resolution](../plans/2026-07-29-plugin-path-resolution.md), [plugin-dependencies-and-monitors](../plans/2026-07-30-plugin-dependencies-and-monitors.md) |
| ✅ | 11 | B2 | Observability and cost reporting | [observability-and-cost](../plans/2026-07-29-observability-and-cost.md) |
| ✅ | 11 | B3 | — (hardening, no single row) | [isolation-hardening](../plans/2026-07-29-isolation-hardening.md) |
| ✅ | 12 | R14 | — (not parity; guards the series) | [nestor-cloud-verification](../plans/2026-07-29-nestor-cloud-verification.md) |
| ✅ | 12 | R16 | — (plugin format, not an §A row) | [codex-adapter-spec](../plans/2026-07-29-codex-adapter-spec.md), [adapter-collisions](../plans/2026-07-30-adapter-collisions.md) |
| ✅ | — | PX | none | — |
| ✅ | — | P1 | none | — |
| ✅ | — | P2 | none | — |
| ✅ | — | P3 | Hook PreToolUse decision contract; Plugin LSP servers | [hook-runtime-contract](../plans/2026-07-30-hook-runtime-contract.md) |
| ✅ | — | P4 | Turn and budget caps; Termination reporting | — |
| ✅ | — | P5 | MCP config, scopes and auth extras; MCP reconnection | — |
| ✅ | — | P6 | 7 (part) | — |
| ✅ | — | P7 | Skill auto-invocation | — |
| ✅ | — | P8 | Instruction file discovery | — |
| ✅ | — | P9 | Subagent definition and inheritance; Subagent output safety scan | — |
| ✅ | — | P10 | Channel push security; Sandbox configuration surface; Sandbox escape hatch and… | — |
| ✅ | — | — | Tool search / deferred loading | — |
| ✅ | 13 | N1 | Nested instruction files below the cwd | [instructions-and-context-surface](../plans/2026-07-30-instructions-and-context-surface.md) |
| ✅ | 13 | N2 | /context optimization suggestions | [instructions-and-context-surface](../plans/2026-07-30-instructions-and-context-surface.md) |
| ✅ | 13 | N3 | Subagent model env override | [switches-and-sandbox-key](../plans/2026-07-30-switches-and-sandbox-key.md) |
| ✅ | 13 | N4 | Bundled-skills off switch | [switches-and-sandbox-key](../plans/2026-07-30-switches-and-sandbox-key.md) |
| ✅ | 13 | N5 | Safe mode | [switches-and-sandbox-key](../plans/2026-07-30-switches-and-sandbox-key.md) |
| ✅ | 13 | N6 | Non-interactive background wait | [switches-and-sandbox-key](../plans/2026-07-30-switches-and-sandbox-key.md) |
| ✅ | 13 | N7 | .mcp.json oauth object | [mcp-surfaces](../plans/2026-07-30-mcp-surfaces.md) |
| ✅ | 13 | N8 | WebSocket MCP transport | [mcp-surfaces](../plans/2026-07-30-mcp-surfaces.md) |
| ✅ | 13 | N9 | URL-elicitation display safety | [mcp-surfaces](../plans/2026-07-30-mcp-surfaces.md) |
| ✅ | 13 | N10 | sandbox.filesystem.disabled | [switches-and-sandbox-key](../plans/2026-07-30-switches-and-sandbox-key.md) |
| ✅ | 14 | D1 | managed-automode-classifyallshell-unread | [managed-policy-honesty](../plans/2026-07-30-managed-policy-honesty.md) |
| ✅ | 14 | D2 | managed-only-lock-misses-flat-widening-arrays | [managed-policy-honesty](../plans/2026-07-30-managed-policy-honesty.md) |
| ✅ | 14 | D3 | anchored-path-rules-dropped-from-settings | [managed-policy-honesty](../plans/2026-07-30-managed-policy-honesty.md) |
| ✅ | 14 | D4 | delivered-policy-frozen-at-construction | [managed-policy-honesty](../plans/2026-07-30-managed-policy-honesty.md) |
| ✅ | 14 | D5 | pi-prompt-hooks-fire-and-forget | [hook-verdicts](../plans/2026-07-30-hook-verdicts.md) |
| ✅ | 14 | D6 | http-hook-response-discarded | [hook-verdicts](../plans/2026-07-30-hook-verdicts.md) |
| ✅ | 14 | D7 | hook-stdin-never-written | [hook-verdicts](../plans/2026-07-30-hook-verdicts.md) |
| ✅ | 14 | D8 | mcp-tool-hook-result-discarded | [hook-verdicts](../plans/2026-07-30-hook-verdicts.md) |
| ✅ | 14 | D9 | skill-agent-frontmatter-hooks-never-register | [hook-verdicts](../plans/2026-07-30-hook-verdicts.md) |
| ✅ | 14 | D10 | credential-deny-roots-too-narrow | [read-side-exposure](../plans/2026-07-30-read-side-exposure.md) |
| ✅ | 14 | D11 | no-read-allowlist-in-any-isolation-profile | [read-side-exposure](../plans/2026-07-30-read-side-exposure.md) |
| ✅ | 14 | D12 | stop-hook-background-shell-has-no-command | [record-and-floor](../plans/2026-07-30-record-and-floor.md) |
| ✅ | 14 | D13 | managed-policy-cannot-deliver-marketplace | [plugin-rollout](../plans/2026-07-30-plugin-rollout.md) |
| ✅ | 14 | D14 | plugin-user-config-inert-outside-hooks | [plugin-rollout](../plans/2026-07-30-plugin-rollout.md) |
| ✅ | 14 | D15 | plugin-config-not-prompted-at-enable | [plugin-rollout](../plans/2026-07-30-plugin-rollout.md) |
| ✅ | 14 | D16 | removal-breaker-misses-windows-spellings | [record-and-floor](../plans/2026-07-30-record-and-floor.md) |
| ✅ | 14 | D17 | subtask-result-not-in-transcript | [record-and-floor](../plans/2026-07-30-record-and-floor.md) |
| ✅ | — | L1 | Fork panel progress | [last-three](../plans/2026-07-30-last-three.md) |
| ✅ | — | L2 | Permission card lifecycle | [last-three](../plans/2026-07-30-last-three.md) |
| ✅ | 9 | V1 | Permission evaluation and modes — the vocabulary and gate half | [claude-mode-vocabulary](../plans/2026-07-31-claude-mode-vocabulary.md), [mode-table-and-labels](../plans/2026-07-31-mode-table-and-labels.md) |
| ✅ | 10 | V2 | Plugin MCP install contract (deepens the B1 plugin series) | [plugin-install-usability](../plans/2026-07-31-plugin-install-usability.md) |
| ✅ | 11 | V3 | Plugin MCP ownership (completes V2's contract) | [adr-plugin-mcp-capability-path](../plans/2026-07-31-adr-plugin-mcp-capability-path.md), [plugin-mcp-capability-path](../plans/2026-07-31-plugin-mcp-capability-path.md) |
| ✅ | — | L4 | Packaged interceptor pairing | [fork-permission-hang](../plans/2026-07-31-fork-permission-hang.md) |
| ✅ | — | L5 | Subagent permission prompts | [fork-permission-hang](../plans/2026-07-31-fork-permission-hang.md) |
| 🛡 | — | — | Corporate gateway auth and multi-backend | — |
| 🛡 | — | — | Hook runtime hardening | — |
| 🛡 | — | — | MCP connection timing and dynamic updat… | — |
| 🛡 | — | — | Memory consolidation and AGENTS.md | — |
| 🛡 | — | — | Process supervision and credential expo… | — |
| ✅ | — | L3 | Prompt caching and pinning | — |
| 🛡 | — | — | Stop, redirect and queued messages | — |
| 🛡 | — | — | Streaming shape and subagent deltas | — |
| 🛡 | — | — | Subagent permission inheritance | — |
| 🛡 | — | — | Windows sandboxing | — |
| ✅ | — | R31 | admin-setup, auto-mode-config, env-vars, large-codebases, permissions | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R32 | agent-sdk/hooks, agent-sdk/typescript, changelog, whats-new/2026-w22 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R33 | context-window, glossary, how-claude-code-works, memory | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R34 | agent-sdk/mcp, mcp, mcp-quickstart, whats-new/2026-w20 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R35 | agent-sdk/subagents, changelog, env-vars, sub-agents | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R36 | agent-sdk/slash-commands, best-practices, interactive-mode | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R37 | whats-new/2026-w26 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R38 | claude-directory, desktop, large-codebases, worktrees | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R39 | scheduled-tasks | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R40 | amazon-bedrock, authentication, llm-gateway-protocol, network-config | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R41 | chrome, tools-reference | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R42 | glossary | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R43 | deep-links | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R44 | output-styles | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R45 | agent-sdk/typescript | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R47 | goal | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R48 | whats-new/2026-w29 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R49 | troubleshoot-install, troubleshooting | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R51 | settings | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R52 | model-config, whats-new/2026-w24, whats-new/index | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R54 | hooks, whats-new/2026-w19 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R55 | memory | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R56 | errors, memory | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R57 | channels, channels-reference, mcp | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R58 | agent-sdk/mcp | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R59 | best-practices, changelog, headless | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R60 | env-vars, sub-agents | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R61 | features-overview, skills | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R62 | desktop-scheduled-tasks | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R63 | discover-plugins, settings | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R64 | cloud-environments, hooks, hooks-guide, whats-new/2026-w15 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R65 | agent-sdk/modifying-system-prompts, third-party-integrations | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R66 | best-practices, headless | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R67 | claude-directory, sub-agents | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R68 | workflows | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R70 | features-overview, skills | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R71 | code-review | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R72 | plugin-dependencies, whats-new/index | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R73 | hooks, whats-new/2026-w16 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R74 | whats-new/2026-w13, whats-new/2026-w20 | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R75 | claude-directory, commands | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R76 | plugins, plugins-reference | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R77 | memory | — |
| ✅ | — | R78 | skills | — |
| ✅ | — | R79 | skills, features-overview | — |
| ✅ | — | R81 | discover-plugins, plugins-reference | — |
| ✅ | — | R82 | discover-plugins, plugins-reference | — |
| ✅ | — | R83 | discover-plugins | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R84 | hooks | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R85 | hooks, cloud-environments | [doc-sweep-parity-wave](../plans/2026-08-04-doc-sweep-parity-wave.md) |
| ✅ | — | R69b | skills | — |
| ✅ | — | R89 | skills | — |
| ✅ | — | R88 | discover-plugins, plugins-reference | — |
| ✅ | — | R88b | plugins | — |
| ✅ | — | R53c | statusline | — |
| ✅ | — | R87 | hooks | — |

## 2. What is deferred or divergent

**The `plan` column answers "is anyone going to do this?"** — a link means the work is planned and the plan says how; `—` means no plan exists yet.

### 2a. Open parity rows — 7

|  | ord | unit | behaviour | what is missing | plan |
| --- | --- | --- | --- | --- | --- |
| ⏸ parked | 8 | R19 | Sandbox network policy | Plan written and kept for when restrictions are wanted: 2026-07-28-egress-proxy.md (contract distilled from sandboxing.md — R19 has no doc-verification entry). Instead of restricting, d214cb63 OPENED egress: shell comma… | [egress-proxy](../plans/2026-07-28-egress-proxy.md) |
| ⏸ parked | — | R13 | Rewind and file checkpoints | — | — |
| ⏸ parked | — | — | Bash isolation on the Claude backend | Prompts bypassed with no isolation underneath — the configuration Claude's own… | — |
| 🔄 partial | — | R69 | skills | 1×built-wrong, 1×not-built; findings f058, f062; spec in 2026-08-02-claude-doc-sweep-worklist.md Partially closed 2026-08-07, doc-sweep parity wave: da73600fb. f058 is DONE — a skill's ! shell placeholders now execute a… | — |
| ⏸ parked | — | R80 | plugins-reference, discover-plugins | Deferred by owner decision 2026-08-07: not needed. It is a DEVELOPER surface and our distribution path is an internal marketplace. Recorded for whoever reopens it: the capability is NOT missing — plugins/mcpb-archive.ts… | — |
| ⬜ unowned | — | R86 | sub-agents | Found by an agent-system analysis against the live docs and verified line by line by the orchestrator. Filed rather than fixed in passing: routing it starts a turn on completion — the documented behaviour, but with real… | — |
| ⬜ unowned | — | R87b | hooks, sub-agents | Split from R87 2026-08-08; skills work today, this is the larger subagent half. | — |

### 2b. Recorded deviations — 363

326 buildable but deliberately not built, 17 impossible on this runtime, 20 with no counterpart in this product. **None of these is planned work** — each is a recorded decision, and the plan linked below carries its reason. The audit's rule is that a gap may be left open but never left unnamed.


## 3. By Claude's documentation

The same picture from the contract's side. **Claude Code's docs are a contract source for this fork, not inspiration** — so this table answers the question a reviewer actually asks: *for THIS page, where do we stand?* It is the axis to use when a page changes upstream.

A page's row set is harvested from the tracker row AND from the plan that built it, because most citations live in the plan. **Line numbers are deliberately not carried here:** pages grow, and this audit has already had six citations drift by seven lines when a page changed between two fetches. The quoted sentence in the plan is the identifier; this table is the map to it.

**Every page in `llms.txt` is listed, including the ones nothing cites** — a coverage map without its denominator is a list of what we happened to look at. Pages are validated against [`scripts/claude-doc-pages.tsv`](../../../scripts/claude-doc-pages.tsv); before that allowlist existed this table admitted Codex and MCP pages under a heading that says Claude, and omitted the uncited pages entirely.

**113 of 210 pages are cited by a row or a plan; 97 are cited by neither.** Of the 113, 80 carry a tracker row and 33 are cited only by a plan — the `state` column says which.

| Claude page | our rows | state | recorded deviations |
| --- | --- | --- | --- |
| `settings` | B1 D1 D10 D11 D13 D14 D15 D2 D3 D4 N10 N3 N4 N5 N6 N7 N8 N9 R11 R12 R17 R19 R2 R24 R25 R26 R3 R30 R31 R32 R33 R34 R35 R36 R37 R38 R39 R4 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R7 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 V1 | 1 open: R19 | 48 |
| `hooks` | D12 D16 D17 D5 D6 D7 D8 D9 P3 R1 R15 R16 R2 R20 R21 R22 R24 R27 R3 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 R87 R87b R9 | 1 open: R87b | 29 |
| `permissions` | D1 D12 D16 D17 D2 D3 D4 L1 L2 L4 L5 R1 R15 R21 R27 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 15 |
| `mcp` | N7 N8 N9 R11 R12 R17 R18 R24 R3 R30 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R5 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 V2 V3 — | all built | 33 |
| `skills` | N1 N2 R17 R30 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R5 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R69 R69b R70 R71 R72 R73 R74 R75 R76 R78 R79 R83 R84 R85 R89 | 1 open: R69 | 8 |
| `tools-reference` | R1 R11 R17 R2 R20 R21 R27 R3 R30 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 V1 | all built | 19 |
| `auto-mode-config` | D1 D2 D3 D4 R1 R21 R27 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 V1 | all built | 12 |
| `sub-agents` | L1 L2 L4 L5 R29 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 R86 R87b | 2 open: R86 R87b | 8 |
| `env-vars` | N10 N3 N4 N5 N6 R27 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 8 |
| `memory` | N1 N2 R11 R16 R28 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R77 R83 R84 R85 | all built | 8 |
| `workflows` | N10 N3 N4 N5 N6 R31 R32 R33 R34 R35 R36 R37 R38 R39 R4 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 4 |
| `errors` | D13 D14 D15 R11 R18 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 5 |
| `model-config` | N10 N3 N4 N5 N6 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 4 |
| `agent-sdk/plugins` | D13 D14 D15 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 R88b | all built | 2 |
| `agent-sdk/typescript` | B2 R20 R3 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 16 |
| `network-config` | R25 R26 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 5 |
| `worktrees` | R15 R2 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 2 |
| `llm-gateway-protocol` | B2 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 15 |
| `plugins/cli-reference` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R82 R83 R84 R85 | all built | 0 |
| `scheduled-tasks` | R3 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 1 |
| `statusline` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R53c R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `admin-setup` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `agent-sdk/mcp` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `amazon-bedrock` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `authentication` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `best-practices` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `changelog` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `chrome` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `deep-links` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `desktop-scheduled-tasks` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `glossary` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `goal` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `headless` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `interactive-mode` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `large-codebases` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `mcp-quickstart` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `output-styles` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `plugins/install` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `plugins/loading` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `plugins/org` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `troubleshoot-install` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `troubleshooting` | R31 R32 R33 R34 R35 R36 R37 R38 R39 R40 R41 R42 R43 R44 R45 R47 R48 R49 R51 R52 R54 R55 R56 R57 R58 R59 R60 R61 R62 R63 R64 R65 R66 R67 R68 R70 R71 R72 R73 R74 R75 R76 R83 R84 R85 | all built | 0 |
| `sandboxing` | B3 D10 D11 L1 L2 N10 N3 N4 N5 N6 R19 | 1 open: R19 | 15 |
| `hooks-guide` | D5 D6 D7 D8 D9 P3 R22 R64 R9 | all built | 9 |
| `server-managed-settings` | D1 D13 D14 D15 D2 D3 D4 R25 R26 | all built | 8 |
| `context-window` | N1 N2 R11 R17 R3 R30 R33 — | all built | 8 |
| `debug-your-config` | N1 N2 R11 R17 R3 R30 | all built | 8 |
| `permission-modes` | R1 R15 R2 R21 R27 V1 | all built | 13 |
| `monitoring-usage` | B2 R12 R24 R25 R26 | all built | 26 |
| `plugins/components` | B1 R12 R24 V2 V3 | all built | 29 |
| `claude-directory` | R12 R38 R67 R75 | all built | 6 |
| `plugins/manifest-reference` | D14 R17 V2 V3 | all built | 23 |
| `features-overview` | R61 R70 R79 | all built | 0 |
| `agent-sdk/hooks` | R7 R9 | all built | 6 |
| `channels-reference` | R3 R57 | all built | 1 |
| `cloud-environments` | R64 R85 | all built | 0 |
| `commands` | R11 R75 | all built | 1 |
| `desktop` | R2 R38 | all built | 2 |
| `prompt-caching` | L3 R11 | all built | 1 |
| `whats-new/index` | R52 R72 | all built | 0 |
| `agent-sdk/hosting` | R6 | all built | 0 |
| `agent-sdk/modifying-system-prompts` | R65 | all built | 0 |
| `agent-sdk/observability` | B2 | all built | 15 |
| `agent-sdk/permissions` | R15 | all built | 2 |
| `agent-sdk/python` | R3 | all built | 1 |
| `agent-sdk/session-storage` | R6 | all built | 0 |
| `agent-sdk/sessions` | R6 | all built | 0 |
| `agent-sdk/structured-outputs` | R18 | all built | 2 |
| `agent-sdk/subagents` | R35 | all built | 0 |
| `agent-sdk/todo-tracking` | R20 | all built | 0 |
| `agent-sdk/user-input` | R7 | all built | 0 |
| `analytics` | B2 | all built | 15 |
| `channels` | R57 | all built | 0 |
| `checkpointing` | R12 | all built | 6 |
| `code-review` | R71 | all built | 0 |
| `costs` | B2 | all built | 15 |
| `how-claude-code-works` | R33 | all built | 0 |
| `plugins/overview` | B1 | all built | 8 |
| `sandbox-environments` | B3 | all built | 3 |
| `third-party-integrations` | R65 | all built | 0 |
| `accessibility` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `advisor` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `agent-sdk/agent-loop` | — | no row — cited by [claude-backend-turn-contract](../plans/2026-07-25-claude-backend-turn-contract.md), [permissions-correctness](../plans/2026-07-25-permissions-correctness.md), [tool-search](../plans/2026-07-30-tool-search.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `agent-sdk/claude-code-features` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `agent-sdk/cost-tracking` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `agent-sdk/custom-tools` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `agent-sdk/file-checkpointing` | — | no row — cited by [rewind-link-safety](../plans/2026-07-29-rewind-link-safety.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [integrations-and-authorization](../plans/2026-09-10-integrations-and-authorization.md), [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md) | 0 |
| `agent-sdk/secure-deployment` | — | no row — cited by [dp-auth-wave2-and-mcp-exposure](../plans/2026-08-22-dp-auth-wave2-and-mcp-exposure.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md) | 0 |
| `agent-sdk/skills` | — | no row — cited by [skills-invocation](../plans/2026-07-26-skills-invocation.md), [base-context-diet](../plans/2026-08-15-base-context-diet.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [wave-2-brief](../plans/2026-09-02-wave-2-brief.md), [wave-8-brief](../plans/2026-09-06-wave-8-brief.md) | 0 |
| `agent-sdk/streaming-output` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `agent-sdk/streaming-vs-single-mode` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `agent-view` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md) | 0 |
| `agents` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `artifacts` | — | no row — cited by [upstream-adoption-0-13-4-board-planning-pages](../plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md) | 0 |
| `claude-security` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `cli-reference` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [wave-8-brief](../plans/2026-09-06-wave-8-brief.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `cross-session-messaging` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `desktop-wsl` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `gateways` | — | no row — cited by [claude-sdk-runtime-on-nessy-integrations](../plans/2026-08-04-claude-sdk-runtime-on-nessy-integrations.md) | 0 |
| `keybindings` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `llm-gateway-connect` | — | no row — cited by [claude-sdk-runtime-on-nessy-integrations](../plans/2026-08-04-claude-sdk-runtime-on-nessy-integrations.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `managed-mcp` | — | no row — cited by [managed-mcp-entries](../plans/2026-07-29-managed-mcp-entries.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [wave-2-brief](../plans/2026-09-02-wave-2-brief.md) | 0 |
| `managed-settings` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [wave-2-brief](../plans/2026-09-02-wave-2-brief.md), [wave-7-brief](../plans/2026-09-05-wave-7-brief.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `overview` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md), [upstream-adoption-0-13-4-board-planning-pages](../plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md) | 0 |
| `plugins/anthropic-marketplaces` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `plugins/code-intelligence` | — | no row — cited by [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `plugins/host-marketplace` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `plugins/marketplace-reference` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `security` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |
| `security-guidance` | — | no row — cited by [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md) | 0 |
| `sessions` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `settings-reference` | — | no row — cited by [hook-type-contract](../plans/2026-07-26-hook-type-contract.md), [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md), [wave-2-brief](../plans/2026-09-02-wave-2-brief.md), [integrations-and-authorization](../plans/2026-09-10-integrations-and-authorization.md), [coverage-95-parity](../plans/2026-09-11-coverage-95-parity.md), [integrations-followup-1.41.0](../plans/2026-09-18-integrations-followup-1.41.0.md) | 0 |
| `vs-code` | — | no row — cited by [runtime-parity-closure](../plans/2026-08-22-runtime-parity-closure.md) | 0 |

### 3a. Claude pages no row and no plan cites — 97

**Uncited is not the same as unread, and neither is the same as unimplemented.** But this series' own rule is that a plan or commit cites the page it implements against, so by our own standard nothing here has been verified. A page may well resolve to one line of `inapplicable`; the point is that the line does not exist yet.

**This number and the coverage map's are not the same measurement, and the crosswalk below is here so nobody has to guess which to believe.** [`2026-07-31-claude-coverage-map.md`](2026-07-31-claude-coverage-map.md) counts *in-product pages not green on Pi* and subtracts every ⬜ page from its denominator; this section counts *pages nothing cites*, over the whole corpus. Most of the gap between the two is that ⬜ subtraction, not a disagreement about coverage. A page that is 🟩 here IS a disagreement — 🟩 means the map found a closed row citing the page, which is the thing this section says does not exist.

| map's Pi verdict | pages | how to read it |
| --- | --- | --- |
| ⬜ | 53 | out of product — **excluded from the map's denominator**, counted here |
| 🟨 | 19 | feature exists, contract not taken — both agree |
| 🟥 | 9 | gap — both agree |
| ⏸ | 0 | row open or parked — both agree |
| 🟩 | 16 | **contradiction**: the map says a closed row cites it and this section says none does |
| not in the map | 0 | a row is missing from the map |

**15 of the 16 contradictions are weekly changelog pages** (`whats-new/2026-w13`, `whats-new/2026-w14`, `whats-new/2026-w15`, `whats-new/2026-w16`, `whats-new/2026-w17`, `whats-new/2026-w18`, `whats-new/2026-w19`, `whats-new/2026-w20`, `whats-new/2026-w21`, `whats-new/2026-w22`, `whats-new/2026-w24`, `whats-new/2026-w26`, `whats-new/2026-w29`, `whats-new/2026-w30`, `whats-new/2026-w32`) and are explained rather than open: a week's read is recorded in a findings SPEC, not in a plan, and this section scans plans. They are left in the count instead of allowlisted away, because the map's own convention is that a weekly verdict asserts the week was read AND its findings decomposed — and only two weeks have a full decomposition.

**The remaining 1 is a real contradiction**: `plugins/dependencies`. Nothing in the tracker or in any plan cites it, so the 🟩 rests on something other than the closed row the map's own definition of 🟩 requires.

**18 of these pages ARE named somewhere in the tracker or a plan, but without the `.md` suffix** (`` `agent-sdk/migration-guide` ``-style, usually as a unit name). They stay counted as uncited: measured, most such mentions are lists of names or coincident unit names rather than citations, and admitting them would certify contracts nobody took. Named here so the ambiguity is visible instead of silent: `agent-sdk/migration-guide`, `agent-sdk/tool-search`, `agent-teams`, `corporate-launcher`, `data-usage`, `devcontainer`, `llm-gateway`, `mobile`, `plugins/cli-hints`, `plugins/create`, `plugins/dependencies`, `plugins/measure`, `plugins/relevance`, `remote-control`, `routines`, `settings-example`, `setup`, `ultrareview`.

| Claude page | map's Pi verdict | what it is |
| --- | --- | --- |
| `agent-sdk/configuration` | 🟨 | Configure your agent |
| `agent-sdk/examples` | ⬜ | Examples |
| `agent-sdk/migration-guide` | 🟨 | Migrate to Claude Agent SDK |
| `agent-sdk/overview` | 🟥 | Agent SDK overview |
| `agent-sdk/quickstart` | 🟥 | Quickstart |
| `agent-sdk/tool-search` | 🟨 | Scale to many tools with tool search |
| `agent-sdk/troubleshooting` | ⬜ | Troubleshoot the Agent SDK |
| `agent-sdk/typescript-v2-preview` | 🟥 | TypeScript SDK V2 session API (removed) |
| `agent-teams` | 🟨 | Orchestrate teams of Claude Code sessions |
| `champion-kit` | ⬜ | Champion kit |
| `claude-apps-gateway` | ⬜ | Claude apps gateway for Amazon Bedrock, Claude Platform on AWS, Google Cloud, and Microsoft Foundry |
| `claude-apps-gateway-config` | ⬜ | Claude apps gateway configuration |
| `claude-apps-gateway-deploy` | ⬜ | Claude apps gateway deployment and operations |
| `claude-apps-gateway-on-aws` | ⬜ | Deploy Claude apps gateway on AWS |
| `claude-apps-gateway-on-gcp` | ⬜ | Deploy Claude apps gateway on Google Cloud |
| `claude-apps-gateway-spend-limits` | ⬜ | Claude apps gateway spend limits |
| `claude-code-on-the-web` | ⬜ | Use Claude Code in the cloud |
| `claude-platform-on-aws` | ⬜ | Claude Code on Claude Platform on AWS |
| `claude-projects` | ⬜ | Let Claude coordinate ongoing work with Projects |
| `claude-tag` | ⬜ | Claude Tag |
| `common-workflows` | ⬜ | Common workflows |
| `communications-kit` | ⬜ | Communications kit |
| `computer-use` | ⬜ | Let Claude use your computer from the CLI |
| `corporate-launcher` | 🟥 | Run Claude Code behind a corporate launcher |
| `data-usage` | 🟥 | Data usage |
| `desktop-ios-simulator` | ⬜ | Test iOS apps in the simulator |
| `desktop-linux` | ⬜ | Claude Desktop on Linux (beta) |
| `desktop-quickstart` | ⬜ | Get started with the desktop app |
| `devcontainer` | ⬜ | Development containers |
| `fast-mode` | ⬜ | Speed up responses with fast mode |
| `feature-availability` | ⬜ | Feature availability |
| `fullscreen` | ⬜ | Fullscreen rendering |
| `github-actions` | ⬜ | Claude Code GitHub Actions |
| `github-actions-cloud-providers` | ⬜ | Use Claude Code GitHub Actions with cloud providers |
| `github-enterprise-server` | ⬜ | Claude Code with GitHub Enterprise Server |
| `gitlab-ci-cd` | ⬜ | Claude Code GitLab CI/CD |
| `google-vertex-ai` | ⬜ | Claude Code on Google Cloud's Agent Platform |
| `jetbrains` | ⬜ | JetBrains IDEs |
| `legal-and-compliance` | 🟥 | Legal and compliance |
| `llm-gateway` | 🟨 | Other LLM gateways |
| `llm-gateway-rollout` | ⬜ | Roll out an LLM gateway for your organization |
| `microsoft-foundry` | ⬜ | Claude Code on Microsoft Foundry |
| `mobile` | ⬜ | Claude Code on mobile |
| `platforms` | ⬜ | Platforms and integrations |
| `plugin-evals` | 🟥 | Test plugins with evals |
| `plugins/cli-hints` | ⬜ | Recommend your plugin from your CLI |
| `plugins/create` | 🟨 | Create a Claude Code plugin |
| `plugins/create-marketplace` | 🟨 | Create a marketplace |
| `plugins/dependencies` | 🟩 | Plugin dependencies |
| `plugins/measure` | 🟨 | Measure plugin cost and usage |
| `plugins/publish` | 🟨 | Publish and distribute a plugin |
| `plugins/relevance` | 🟨 | Recommend plugins for your org |
| `plugins/security` | 🟨 | Plugin security and trust |
| `plugins/troubleshooting` | 🟨 | Troubleshoot plugins |
| `prompt-library` | ⬜ | Prompt library |
| `quickstart` | ⬜ | Quickstart |
| `remote-control` | ⬜ | Continue local sessions from any device with Remote Control |
| `routines` | ⬜ | Automate work with routines |
| `self-hosted-environments` | ⬜ | Self-hosted environments |
| `self-hosted-environments-configuration` | ⬜ | Customize sessions in self-hosted environments |
| `self-hosted-environments-deploy` | ⬜ | Deploy self-hosted environments to production |
| `self-hosted-environments-identity` | ⬜ | Verify session identity in self-hosted environments |
| `self-hosted-environments-quickstart` | ⬜ | Self-hosted environments quickstart |
| `self-hosted-environments-reference` | ⬜ | Self-hosted environments reference |
| `self-hosted-environments-testing` | ⬜ | Test self-hosted environments end to end |
| `settings-example` | ⬜ | Example settings files |
| `setup` | ⬜ | Advanced setup |
| `slack` | ⬜ | Claude Code in Slack |
| `terminal-config` | ⬜ | Configure your terminal for Claude Code |
| `ultrareview` | ⬜ | Find bugs with ultrareview |
| `voice-dictation` | ⬜ | Voice dictation |
| `web-quickstart` | ⬜ | Get started with Claude Code in the cloud |
| `whats-new/2026-w13` | 🟩 | Week 13 · March 23–27, 2026 |
| `whats-new/2026-w14` | 🟩 | Week 14 · March 30 – April 3, 2026 |
| `whats-new/2026-w15` | 🟩 | Week 15 · April 6–10, 2026 |
| `whats-new/2026-w16` | 🟩 | Week 16 · April 13–17, 2026 |
| `whats-new/2026-w17` | 🟩 | Week 17 · April 20–24, 2026 |
| `whats-new/2026-w18` | 🟩 | Week 18 · April 27 – May 1, 2026 |
| `whats-new/2026-w19` | 🟩 | Week 19 · May 4–8, 2026 |
| `whats-new/2026-w20` | 🟩 | Week 20 · May 11–15, 2026 |
| `whats-new/2026-w21` | 🟩 | Week 21 · May 18–22, 2026 |
| `whats-new/2026-w22` | 🟩 | Week 22 · May 25–29, 2026 |
| `whats-new/2026-w23` | 🟨 | Week 23 · June 1–5, 2026 |
| `whats-new/2026-w24` | 🟩 | Week 24 · June 8–12, 2026 |
| `whats-new/2026-w25` | 🟨 | Week 25 · June 15–19, 2026 |
| `whats-new/2026-w26` | 🟩 | Week 26 · June 22–26, 2026 |
| `whats-new/2026-w27` | 🟨 | Week 27 · June 29 – July 3, 2026 |
| `whats-new/2026-w28` | 🟨 | Week 28 · July 6–10, 2026 |
| `whats-new/2026-w29` | 🟩 | Week 29 · July 13–17, 2026 |
| `whats-new/2026-w30` | 🟩 | Week 30 · July 20–24, 2026 |
| `whats-new/2026-w32` | 🟩 | Week 32 · August 3–7, 2026 |
| `whats-new/2026-w33` | 🟥 | Week 33 · August 10–14, 2026 |
| `whats-new/2026-w34` | 🟥 | Week 34 · August 17–21, 2026 |
| `whats-new/2026-w35` | 🟨 | Week 35 · August 24–28, 2026 |
| `whats-new/2026-w36` | 🟨 | Week 36 · August 31 – September 4, 2026 |
| `whats-new/2026-w37` | 🟨 | Week 37 · September 7–11, 2026 |
| `zero-data-retention` | ⬜ | Zero data retention |

### 3b. Cited as documentation, but not a Claude Code page — 132

Kept visible rather than dropped. Codex and MCP pages are real contract sources for this fork (`AGENTS.md` names them), they are just not *this* contract — and folding them in is what made the table above unusable as a coverage map. A name here that is neither is a citation typo worth fixing at the source.

79 name(s) were filtered out before this table as OUR OWN files rather than anyone's documentation: lane reports and the controller's hand-off file, which live outside this repository, and names resolving to a tracked document under `docs/` or `docs-site/`. That filter runs only after a name has failed to resolve against `scripts/claude-doc-pages.tsv`, so it cannot hide a Claude page.

| cited name | times |
| --- | --- |
| `verdicts.md` | 160 |
| `proposed.md` | 86 |
| `plugins-reference.md` | 39 |
| `plugin-marketplaces.md` | 27 |
| `waves.md` | 21 |
| `loop.md` | 12 |
| `slash-commands.md` | 12 |
| `board.md` | 10 |
| `build/plugins.md` | 10 |
| `docs/permissions.md` | 10 |
| `sources.md` | 10 |
| `plugin-json-spec.md` | 9 |
| `context.md` | 8 |
| `submission-errors.md` | 8 |
| `docs/hooks.md` | 7 |
| `au-sittings/sittings-audit.md` | 6 |
| `automations.md` | 6 |
| `en/plugins-reference.md` | 6 |
| `specialized/deploy.md` | 6 |
| `deploy/submission-errors.md` | 5 |
| `plan-upstream-adoption-0-14-0.md` | 5 |
| `reference.md` | 5 |
| `discover-plugins.md` | 4 |
| `docs/board.md` | 4 |
| `docs/pages.md` | 4 |
| `docs/prompting.md` | 4 |
| `docs/sources.md` | 4 |
| `frontend/react.md` | 4 |
| `plugin-dependencies.md` | 4 |
| `prompting.md` | 4 |
| `reviewer.md` | 4 |
| `wi13/review-survivors-pass3-2026-09-20.md` | 4 |
| `a/b.md` | 3 |
| `agents/reviewer.md` | 3 |
| `client/elicitation.md` | 3 |
| `denominator-questions-decided.md` | 3 |
| `deploy.md` | 3 |
| `docs/skills.md` | 3 |
| `f1966/analysis.md` | 3 |
| `fork-patches/mcp-managed-dp-placeholder.md` | 3 |
| `intel/constraints.md` | 3 |
| `references/guide.md` | 3 |
| `rules.md` | 3 |
| `scout.md` | 3 |
| `sdd/progress.md` | 3 |
| `skilldata/core.md` | 3 |
| `w30.md` | 3 |
| `wi15/sit-common.md` | 3 |
| `wi16/sitting-asks.md` | 3 |
| `app-server.md` | 2 |
| `au-reconcile/reconcile-audit.md` | 2 |
| `chooks.md` | 2 |
| `commands/default-cmd.md` | 2 |
| `commands/deploy.md` | 2 |
| `common.md` | 2 |
| `context-windows.md` | 2 |
| `data/findings.md` | 2 |
| `denominator-decision-rows.md` | 2 |
| `docs/artifacts.md` | 2 |
| `docs/notifications.md` | 2 |
| `docs/session-format.md` | 2 |
| `docs/statuses.md` | 2 |
| `en/plugin-marketplaces.md` | 2 |
| `manage-app-updates.md` | 2 |
| `my-project-instructions.md` | 2 |
| `override.md` | 2 |
| `review/security.md` | 2 |
| `rules/style.md` | 2 |
| `sdd/test-mutex.md` | 2 |
| `statuses.md` | 2 |
| `w32.md` | 2 |
| `wi16/docs-handback.md` | 2 |
| `agent-approvals-security.md` | 1 |
| `agent-configuration/rules.md` | 1 |
| `agent-sdk/slash-commands.md` | 1 |
| `agents/cdp-high-effort.md` | 1 |
| `agents/top.md` | 1 |
| `au-release/release-notes-addendum-draft.md` | 1 |
| `batch.md` | 1 |
| `build/skills.md` | 1 |
| `closeout/leftovers-after-closeout.md` | 1 |
| `codex/build-plugins.md` | 1 |
| `codex/plugins.md` | 1 |
| `commands/hello.md` | 1 |
| `commands/review.md` | 1 |
| `custom/cmd.md` | 1 |
| `cyber-safety/recommended-configuration.md` | 1 |
| `designs/harness-capabilities-bench-seam.md` | 1 |
| `docs/adr-transport-locality.md` | 1 |
| `docs/app-server.md` | 1 |
| `docs/automations.md` | 1 |
| `docs/build-plugins.md` | 1 |
| `docs/image-preview.md` | 1 |
| `docs/models.md` | 1 |
| `docs/plugins.md` | 1 |
| `docs/web-search.md` | 1 |
| `elicitation.md` | 1 |
| `en/slash-commands.md` | 1 |
| `enterprise/manage-app-updates.md` | 1 |
| `final-gate-summary.md` | 1 |
| `fork-patches/desktop-linux-update-signing.md` | 1 |
| `fuses.md` | 1 |
| `handbacks/vf-1-2.md` | 1 |
| `intel/decisions.md` | 1 |
| `lang-spec/chapter-02.md` | 1 |
| `leftovers-after-closeout.md` | 1 |
| `local.md` | 1 |
| `models/list.md` | 1 |
| `next.md` | 1 |
| `notes.md` | 1 |
| `output-styles/terse.md` | 1 |
| `owner-decisions-2026-09-18-followup-1-41-0.md` | 1 |
| `payload.md` | 1 |
| `plans/x.md` | 1 |
| `plugin-relevance.md` | 1 |
| `plugin/vulnerability-reports.md` | 1 |
| `reference/troubleshooting.md` | 1 |
| `references/plugin-json-spec.md` | 1 |
| `rules/api.md` | 1 |
| `sit-11-claude-gateway-evidence.md` | 1 |
| `sit-11-codex-evidence.md` | 1 |
| `sit-common.md` | 1 |
| `specs/runtime-capability-gaps.md` | 1 |
| `target.md` | 1 |
| `thinking.md` | 1 |
| `wi13/ci-fails-126374378.md` | 1 |
| `wi14/resume-2026-09-20.md` | 1 |
| `wi15/common.md` | 1 |
| `work/decision-rows.md` | 1 |
| `work/posture-decision-rows.md` | 1 |
| `worklist.md` | 1 |
| `x/context.md` | 1 |

## 4. Deviations by the plan that recorded them

| recorded while executing | deviations |
| --- | --- |
| plans/2026-07-29-hook-context-injection.md | 19 |
| plans/2026-07-29-output-style-contract.md | 19 |
| plans/2026-07-29-marketplace-entry-authority.md | 17 |
| plans/2026-07-29-deviation-unit-6.md | 16 |
| plans/2026-07-29-effort-precedence.md | 15 |
| plans/2026-07-29-observability-and-cost.md | 15 |
| plans/2026-07-29-fork-surface.md | 9 |
| plans/2026-07-29-inert-unit-b.md | 9 |
| plans/2026-07-29-plugin-user-config.md | 9 |
| plans/2026-07-29-sandbox-network-enforcement.md | 9 |
| plans/2026-07-29-plugin-authoring-tooling.md | 8 |
| plans/2026-07-30-plugin-dependencies-and-monitors.md | 8 |
| plans/2026-07-31-install-and-revoked-lease.md | 8 |
| plans/2026-07-31-plugin-install-usability.md | 8 |
| plans/2026-08-17-claude-live-session.md | 8 |
| plans/2026-07-30-sandbox-mach-and-protected-paths.md | 7 |
| plans/2026-07-31-plugin-mcp-capability-path.md | 7 |
| specs/2026-08-02-claude-doc-sweep-divergences.md | 7 |
| docs/architecture/file-checkpoint-rewind.md | 6 |
| plans/2026-07-30-hook-runtime-contract.md | 6 |
| plans/2026-07-30-reachable-surfaces.md | 6 |
| plans/2026-07-30-tool-search.md | 6 |
| plans/2026-08-11-mcp-followups-f2-f4.md | 6 |
| plans/2026-07-29-codex-adapter-spec.md | 5 |
| plans/2026-07-29-deviation-unit-5.md | 5 |
| plans/2026-07-29-inert-units-cd.md | 5 |
| plans/2026-07-30-last-three.md | 5 |
| plans/2026-07-30-mentions-and-skill-vars.md | 5 |
| docs/architecture/fork-subagents.md | 4 |
| docs/architecture/managed-mcp-access.md | 4 |
| plans/2026-07-29-deviation-unit-4.md | 4 |
| plans/2026-07-29-doctor-surface.md | 4 |
| plans/2026-07-29-nestor-cloud-verification.md | 4 |
| plans/2026-07-29-subagent-frontmatter.md | 4 |
| plans/2026-07-30-managed-values-and-telemetry.md | 4 |
| plans/2026-07-30-manifest-mode-and-aliases.md | 4 |
| plans/2026-07-30-mcp-surfaces.md | 4 |
| plans/2026-07-30-prompt-cache-and-egress-disclosure.md | 4 |
| plans/2026-07-30-switches-and-sandbox-key.md | 4 |
| plans/2026-07-31-claude-mode-vocabulary.md | 4 |
| plans/2026-08-12-sandbox-default-off-and-bypass-cli-parity.md | 4 |
| plans/2026-08-20-cross-runtime-history-carry.md | 4 |
| specs/2026-07-25-nessy-claude-parity-audit.md | 4 |
| specs/2026-08-02-claude-doc-sweep-worklist.md | 4 |
| plans/2026-07-29-isolation-hardening.md | 3 |
| plans/2026-07-29-plugin-activation-and-styles.md | 3 |
| plans/2026-07-30-hook-verdicts.md | 3 |
| plans/2026-07-30-read-side-exposure.md | 3 |
| plans/2026-07-31-mode-table-and-labels.md | 3 |
| plans/2026-07-29-deviation-unit-3.md | 2 |
| plans/2026-07-29-fork-subagents.md | 2 |
| plans/2026-07-29-removal-circuit-breaker.md | 2 |
| plans/2026-07-29-session-scheduling.md | 2 |
| plans/2026-07-29-stop-hook-payload.md | 2 |
| plans/2026-07-30-approval-path-truth.md | 2 |
| plans/2026-07-30-instructions-and-context-surface.md | 2 |
| plans/2026-07-30-pinned-block-repetition.md | 2 |
| plans/2026-07-30-plugin-rollout.md | 2 |
| plans/2026-07-30-record-and-floor.md | 2 |
| plans/2026-07-30-subprocess-contracts.md | 2 |
| plans/2026-08-12-audit-defect-closure.md | 2 |
| plans/2026-07-29-delivered-policy-enforcement.md | 1 |
| plans/2026-07-29-deviation-unit-1.md | 1 |
| plans/2026-07-29-deviation-unit-2.md | 1 |
| plans/2026-07-29-rewind-link-safety.md | 1 |
| plans/2026-07-30-false-surfaces.md | 1 |
| plans/2026-07-30-managed-policy-honesty.md | 1 |
| plans/2026-07-31-fork-permission-hang.md | 1 |

