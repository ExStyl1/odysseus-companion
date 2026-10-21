# Runtime capability matrix — Pi / Claude / Codex

Written 2026-08-22, from the two coverage maps (`2026-07-31-claude-coverage-map.md`,
`2026-08-22-codex-coverage-map.md`), the w30/w32 findings, and the renderer UI inventory.
Executed by `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` — the plan's
tracker is the row-status source; this file records the SHAPE of each decision.
Keep in sync at every close-out (the runtime-switch lens is re-derived from it, P4.6).
Structure reference: omnigent's capability matrix + drift bench (do not copy its code).

Legend: ✅ have · ➕ have, extending · ❌→host build host-side (one implementation for all)
· ❌→native adopt the runtime's native API · 📄 recorded deviation · 🔒 lens-hidden on that
runtime deliberately · ⏸ parked.

## Scheduling & events (plan Phase 1)

| Capability | Pi | Claude | Codex | Action |
| --- | --- | --- | --- | --- |
| Cron / self-paced `/loop` / ScheduleWakeup | ✅ | ❌→host (project tools; suppress SDK-native via `CLAUDE_CODE_DISABLE_CRON=1`) | ❌→host (callback bridge) | T1–T3, T5 |
| Monitor (command/ws watch) | ✅ | ❌→host + host gate | ❌→host + host gate | T2/T3/T5 |
| Channels (event push into a session) | ✅ | ✅ | ✅ | none (MCP channel pushes live on all three) |
| Plugin scheduled monitors | ✅ | 🔒 | 🔒 | 📄 Dev-15 (`agent.redirect` is a Pi steering primitive) |

## Orchestration & second models

| Capability | Pi | Claude | Codex | Action |
| --- | --- | --- | --- | --- |
| Subagents | ✅ Task/child sessions | ✅ SDK subagents | ➕ static roles only → ❌→native `features.multi_agent` | P3.4 |
| Advisor | ❌→host | ❌→host (upstream is an Anthropic server-side, flag-gated tool — unreachable via our gateway) | ❌→host | P2.1: consult at the three documented moments over `call_llm`, advisor model = user's entitlement |
| Goal (work until a condition) | ➕ tool exists, pi-only | ❌→host (projection) | ❌→host; native `thread/goal/*` 📄 Dev-9 | P2.2 + P4.2 |
| Review | ✅ host `review` | ✅ | ✅; native `review/start` 📄 Dev-9 | none |
| Agent teams | — | — | — | 📄 Dev-1 (owner: not now) |

## Permissions & security

| Capability | Pi | Claude | Codex | Action |
| --- | --- | --- | --- | --- |
| Cross-session message authority | ❌→host (shared delivery envelope) | same | same | P0.1: task-notification envelope, no attachments |
| Auto mode as default | ❌→host (config default) | same | same | P0.2 |
| Classifier over dangerous rm / background jobs / windows paths | ➕ widen guardian-consult | inherits (shared pre-tool-use) | 📄 (its own approval path) | P2.3 — owner 2026-08-22: "максимально как у Claude", classifier adjudicates ALL THREE incl. rm in auto mode; fail-closed-to-human preserved |
| Bash fail-closed forms (fd-redirect, zsh subscript, help/man) | ❌ finish in `claude-bash-rule.ts` | inherits | ➕ via execpolicy | P2.4 |
| Persistent exec rules | — | — | ❌→native `rules/*.rules` from our DSL + persisted Always Allow | P3.1 |
| Credentials `mode:"mask"` | ⏸ | ⏸ | ⏸ | 📄 Dev-2 — DEFERRED (sandbox off by standing decision; deny-floor stands) |
| auto_review / guardian approvals | — | — | ❌→native `approvals_reviewer` | P3.2 (absorbs the parked runtime-icons follow-up) |
| Managed floor | ✅ managed-policy | ❌→native `Options.managedSettings` | ❌→native `configRequirements/read` | P2.7 |
| Managed in-app-updates gate | ❌→host (`auto-update.ts` + policy key) | — | — | P2.10 |

## Sessions, context, background

| Capability | Pi | Claude | Codex | Action |
| --- | --- | --- | --- | --- |
| Background processes + task chips | ✅ | ✅ | ❌→native `thread/backgroundTerminals/*` (experimental) | P3.3 |
| Structured output | ✅ | ✅ | ❌→native `outputSchema` | P3.5 |
| Long-tool heartbeat | ❌→host (tool-executor) | inherits renderer | inherits | P0.7 |
| `--max-budget-usd` reaches subagents | ❌ finish (spawner + cap) | — | — | P2.5 |
| File checkpointing (file rollback) | ⏸ R13 parked | — | — | stays ⏸ |
| Worktree isolation over Bash/git redirects | ❌ finish enforcement | inherits | 📄 | P2.6 |
| Worktree setup scripts | ❌→host with consent | same | same | P3.6 |
| Background auto-commit on completion | ❌→host (setting-gated; push off) | same | same | P2.11 (DR-2); draft-MR half 📄 Dev-4 |
| Import a Claude Code setup | ❌→host wizard | — | — | P2.9 (Cursor 📄 Dev-13) |

## Catalog & small

| Capability | Action |
| --- | --- |
| `claude-opus-5` in MODEL_REGISTRY (BYO path; BYOK cards flag-off today) | P0.3 |
| Marketplace `archive` source (zip + SHA-256) | P0.4 |
| Plugin activates in the current session | P2.8 |
| `/review` alias | P0.5 |
| Codex image items not silently dropped | P0.6 |
| WSL2 path for Windows | P3.7 spike → decision |
| Contract closing: 31 Claude 🟨 + 49 Codex 🟨 | P5.1/P5.2 sweeps (priority: roles/approvals) |

## The Pi finishing list (base agent, 1:1 with Claude Code)

Everything marked ❌/➕ in the Pi column: advisor, goal finish, three bash fail-closed
forms, classifier widening, subagent budget cap, heartbeat, worktree enforcement
widening, cross-session fix, auto default, setup scripts, archive source, plugin
activation, catalog. Host-side rows land on Pi first — its host channel is already
complete.

## UI disposition (measured; renderer is runtime-agnostic)

Reused as-is: task-notification turns (cron/monitor/cross-session), `PermissionRequest`
card, `ActiveTasksBar` chips, `SubagentCard`/`WorkflowPanel`, image rendering.
Extended: runtime-switch lens rows, slash palette, `renderActivity` advisor card,
AI-settings advisor picker, plugin install summary third state, onboarding import step.
New surfaces (all protocol-first — no RPC exists for them today): scheduled-tasks list
(P4.1), goal status (P4.2), watch list (P4.3); thinking renderer needs only a producer
(P4.4). Pi runtime inspector: DR-1 (63 orphaned i18n keys, `en.json:315-377`).
