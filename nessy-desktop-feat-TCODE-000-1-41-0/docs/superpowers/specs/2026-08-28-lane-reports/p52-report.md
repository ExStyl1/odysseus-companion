# P5.2 — the Codex 🟨 sweep: triaged list

**Audit opened at** `f58f66a36f6314384fef1d4c535f7772dd0ca84b`, **closed at**
`f8d4d505664253f8ac72e75749b033940519e797` (branch `feat/TCODE-000`, 2026-08-28). Six implementation
lanes were committing throughout; the tree moved seven times while this ran. Each of the six lane
files in §7 records the SHA it measured at (`b1824c4b4`, `e6f9208f1`), and every measurement outside
them is dated to `f58f66a36` unless stated. **The severe finding in §0.1 was re-verified at
`8a1c6d310` after the tree moved, and holds.** Anything re-probed later may have moved again.

**Read-only.** No source file was changed. No plan row was opened — the controller opens rows.

---

## 0. Read this first — one severe finding, and one that changes how the rest of the list is used

### 0.1 SEVERE — our codex permission profile may be inert, and nothing in the repo knows it

**Row 90 `permissions`. Kind: bug. Verdict: take the contract. `[doc:codex]`.**

`buildCodexConfigToml` writes `sandbox_mode` **unconditionally** (`packages/codex-responses-adapter/src/config-writer.ts:954`)
and `default_permissions = "nessy_runtime"` next to it (`:956`), then emits the profile itself at
`:1002-1010`. The page forbids exactly that pairing:

> `learn.chatgpt.com/docs/permissions.md#migrate-from-older-sandbox-settings` — "Use one system or the other for a session, not both."

and states the precedence explicitly in the page intro (before the first heading, so no anchor covers
that sentence — nearest normative section is the same `#migrate-from-older-sandbox-settings`):

> "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config
> profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of `default_permissions`."

The page names one exception, which we do not use:

> "Managed `allowed_permission_profiles` is the exception: it makes Codex use permission profiles."

**What is at stake.** The only `deny` we express through the profile is the host credential store:
`deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')]` at `packages/shared/src/agent/codex-agent.ts:1254`,
`:1400`, `:2386` — turned into `[permissions.nessy_runtime.filesystem]` `"…/credentials.enc" = "deny"`
by `resolveRuntimePolicy` (`config-writer.ts:806-812`). If the profile is ignored, that deny is gone,
and the sandbox we actually run under does not replace it — `sandboxing.md#…` describes
`workspace-write` as read-unrestricted:

> `sandboxing.md` (bulleted mode list) — "`workspace-write`: The agent can read files, edit within the
> workspace, and run routine local commands inside that boundary."

So under our default mode the codex agent's own `shell`/`read_file` tools could read
`~/.nessy/credentials.enc`. Mitigating, honestly: the file is the **encrypted** store, and the
session-tools layer has its own independent defence (`packages/session-tools-core/src/runtime/credential-deny-roots.ts`)
which is unaffected — but that layer does not cover codex's *native* tools, which is precisely what the
profile was written to cover.

**Awareness: zero.** `git grep -a -i -E 'do not compose|older sandbox settings|instead of .default_permissions'`
over `packages apps docs` returns exactly one hit, and it is the coverage map's own cell.
Positive control on the same run: `permission profile` matches in `config-writer.ts`.

**NOT-MEASURED, and it matters:** whether the *bundled* binary (`rust-v0.148.0`) implements the
documented precedence. The binary's strings carry `default_permissions refers to undefined profile`,
`requirements.toml default_permissions … must be allowed by allowed_permission_profiles` and
`allowed_permission_profiles refers to undefined profile`, so it knows the whole vocabulary — but a
strings dump cannot show precedence. **Confirming this needs one live run** (start a session, ask the
runtime to read `credentials.enc`, observe). I did not run it: this row is read-only. Until someone
does, treat the finding as "the contract says we are wrong and we have no evidence we are not".

**Three facts that make this worse, found by the lane auditing the sibling `sandboxing` page and
verified independently:**

1. **Our own validator pins the forbidden pairing as an invariant.** `validateConfigAgainstSchema`
   (`config-writer.ts:1085-1087`) *requires* `default_permissions` and `permissions` to be present
   in addition to the always-required `sandbox_mode`. So the combination the page forbids is not an
   oversight in one code path — it is asserted.
2. **The documented escape hatch is unused.** `allowed_permission_profiles` — the one thing the page
   says makes codex honour profiles anyway — is **0 files** repo-wide, as is `allowed_sandbox_modes`.
3. **The legacy key cannot carry the deny.** The bundled release `config-schema.json`'s
   `SandboxWorkspaceWrite` has exactly four properties (`writable_roots`, `network_access`,
   `exclude_slash_tmp`, `exclude_tmpdir_env_var`) and **no deny form at all**. So "just use the
   legacy system" does not restore the credential protection; it would have to move to the host
   PolicyEngine and be documented there.

**Severity, bounded honestly.** The shipped default is `SANDBOX_ENABLED_DEFAULT = false`
(`packages/shared/src/config/sandbox-settings.ts:353`), so today every codex mode but `dontAsk`
already resolves to `danger-full-access` — the deny was never enforced in the default configuration,
and *that* is a recorded, owner-approved deviation. The new fact is that **turning the sandbox back
on does not restore it either**: the operator gets `workspace-write`, believes `credentials.enc` is
denied and the plugin data dir is granted, and neither is true. A control that fails in the position
where it is supposed to work is worse than one that is documented off.

**And there is no detector.** `git grep -a -i -E 'credentials\.enc|permission profile|default_permissions'`
over `docs/testing` returns three hits, all about the *Pi* credential store decrypting during a
figma login run — none about the codex permission profile (positive control: `codex` matches 14
times in `docs/testing/cdp-live-checklist.md`). So no live case would notice this today, in either
direction. Whatever the owner decides, **the live case is part of the fix**, not an optional extra.

**Cost:** small to fix, large to get wrong. Either stop emitting `sandbox_mode` when
`hasFilesystemPolicy` (one conditional at `config-writer.ts:954`) and re-express the mode entirely
through profile `extends` — `resolveRuntimePolicy` already derives `':read-only' | ':workspace'` at
`:808` — or keep `sandbox_mode` and drop the profile as decoration, recording the deny as unenforced.
Touches `config-writer.ts` plus `__tests__/config-writer.test.ts` and `__tests__/sandbox-regression.test.ts`.
The first option interacts with the `danger-full-access` escape at `:400` and with the seven-mode table
at `:325-340`, so it is not a one-liner. **Blocked on the live measurement above** — do not pick a
direction before someone has seen which config actually wins.

### 0.2 The map you are triaging from is five days stale, and at least seven rows have moved

The map was built 2026-08-22 and its row content has not been touched since (`3554e827f` added only the
"no runtime axis" preamble; `git log -- docs/superpowers/specs/2026-08-22-codex-coverage-map.md` = 2 commits).
Between then and `f58f66a36`, 29 commits landed on
`packages/codex-responses-adapter`, `packages/codex-agent-server` and `packages/shared/src/agent/codex-agent.ts`.

Confirmed stale before I dispatched anything:

| Map row | Map said | HEAD says | Landed in |
| --- | --- | --- | --- |
| 5 `agent-configuration/rules` 🟥 | `prefix_rule`/`execpolicy` = 0 in our source | `config-writer.ts` emits `prefix_rule(pattern=[…], decision=…)` into `CODEX_HOME/rules/`; 4 files carry `prefix_rule`, 8 carry `execpolicy` | `7bc247a87`, hardened `bd12361a9` |
| 53 `enterprise/manage-app-updates` 🟥 | updater has no managed gate at all | `packages/shared/src/config/managed-in-app-updates.ts` + tests; `in_app_updates` in 5 files | `39d9d7c88`, `3a6cef117` |
| 54 `enterprise/managed-configuration` 🟨 | `configRequirements/read` never sent; `requirements.toml` in no file of ours | `packages/shared/src/agent/codex-config-requirements.ts` + `app-server-client.ts`; `configRequirements` in 7 files, `requirements.toml` in 5 | `3a6cef117`, fixed `a153915c1` |
| 40 / 89 / 136 auto-review | `approvals_reviewer` never written, 3 guardian notifications silently dropped | `approvals_reviewer` in 5 files incl. `config-writer.ts:953`; `GuardianApprovalReview` handled in `backend/codex/event-adapter.ts` + `auto-review-breaker.ts` | `384e2fb38`, `7736e32a9` |
| 31 / 33 config keys | `[features]` never written (`grep = 0`) | `[features]` + `multi_agent = true` emitted at `config-writer.ts:967-968`; 8 files | (with the multi-agent work) |
| 78 `image-generation` 🟥 | `imageGeneration`/`imageView` handled by nobody, fall into `default:` | handled in `backend/codex/event-adapter.ts`, 3 files | `f785353f5` + `06ca21018` (row P0.6 ✅) |
| 27 `codex-sdk` 🟨 | `turn/start` carries only `threadId` + `input` | `outputSchema` now rides `turn/start` | `5f0f9b244` |

**Consequence for whoever executes P5.2:** the map's cells are excellent measurements *of 2026-08-22*.
Any row dispatched off the cell text without re-probing HEAD will chase a gap that is already closed.
That is not a defect in the map — it is what a dated measurement does — but it must be said out loud,
because the map reads like a current inventory.

### 0.3 Three bookkeeping corrections to the plan itself

1. **The plan's 12-🟥 disposition names eleven subjects, not twelve** (plan line 745, "every gap has a
   home"). Splitting the sentence on `;` yields: execpolicy, manage-app-updates, local-environment,
   image items, import, WSL, Bedrock, computer-use, troubleshooting, remote-connections, deep-scans.
   **`integrated-terminal` (map row 81) is absent.** The nearest thing is `Dev-4`
   ("separate forge/git-UI plan (GitLab MR, auth, git panel, integrated terminal cluster)") — which is
   a recorded *deferral*, not a home. Either say Dev-4 covers it, or it is genuinely unplaced.
2. **P5.2's header says "49 rows"; the map's own verdict table and its actual rows both say 48 🟨.**
   I counted the table directly: 48 🟨, 12 🟥, 3 ⏸, 3 🟩, 73 ⛔ = 139. Off by one since the plan was
   written; reconcile at close-out so the sweep's completion cannot be argued either way.
3. **The codex map has no checker.** `scripts/check-coverage-map.ts` hardcodes
   `MAP_PATH = …/2026-07-31-claude-coverage-map.md` (`:53`) and reports 193 rows across the three
   runtime columns; it never opens the codex map. So the codex map's counts, glyph legality and row
   completeness are gated by nothing. `[doc:none]` — our own tooling. Cheap: the codex map is a
   single-verdict-column table, so a second `MAP_PATH` + a column-count switch is most of it.

### 0.4 Eleven of these pages already have a recorded deviation — do not re-file them

The plan's `## Recorded deviations` block already answers part of this map. Cross-referenced so the
controller does not open duplicate rows:

| Dev | Covers map row(s) |
| --- | --- |
| Dev-4 | 65 `local-environment` (git panel half), 81 `integrated-terminal` |
| Dev-5 | 8 `amazon-bedrock` |
| Dev-6 | 28 `computer-use` |
| Dev-7 | 100 `remote-connections` |
| Dev-8 | 13 `app-server` (`thread/list`/archive/search, `fs/watch`) |
| Dev-9 | 13 `app-server` + 26 `code-review` (`review/start`), 83 `long-running-work` (`thread/goal/*`) |
| Dev-10 | 13 `app-server` (`dynamicTools`) |
| Dev-11 | 98 `reference/troubleshooting`, and the persistence half of 118 `deep-scans` |
| Dev-13 | 80 `import` (sources beyond Claude Code) |
| Dev-16 | the whole `security/plugin/*` cluster (110, 113, 115, 116, 117, 118, 122, 124) |

Open plan rows that already own a 🟥: P3.1 ✅ (5), P2.10 ✅ (53), P2.9 ✅ (80), P3.6 ✅ (65),
P0.6 ✅ (78), P3.7 ⬜ (139), P3.8 ⬜ (118).

---

## 1. The corpus itself has grown — five pages exist that no row covers

This is the finding the brief calls **"never looked at"**, and nothing else in the plan would have
surfaced it: the sweep's stopping rule is *coverage of the corpus*, and the corpus moved.

I re-fetched `https://learn.chatgpt.com/llms.txt` at audit time and diffed it against the snapshot
`scripts/codex-doc-pages.tsv` (`Snapshot: 2026-08-22, 139 pages`).

**Result: 138 unique slugs then, 143 now** (`llms-full.txt` excluded — it is a corpus dump, not a
page). Nothing was removed. Five pages are new:

| New slug | Its subject | First-pass verdict | Kind |
| --- | --- | --- | --- |
| `webmcp` ("Site tools") | WebMCP tools a website offers to the agent **inside the built-in browser** | **take the contract** | never looked at |
| `developer-settings` | app settings: project/terminal behaviour, output limits, **Review delivery Inline/Detached**, IDE sync | take the contract (partly) | never looked at |
| `developer-commands` | full CLI subcommand reference incl. `codex app-server`, `codex execpolicy`, `codex sandbox` | record the divergence as deliberate | never looked at |
| `enterprise/chatgpt-work-cloud-security` | where cloud tasks run, cloud browser, retention | **not our surface** | never looked at |
| `security/cli/ci/gitlab` | Codex Security CLI in GitLab CI pipelines | **not our surface** | never looked at |

### 1.1 `webmcp` — the one that lands squarely on a surface we ship. `[doc:codex]`

> `webmcp.md` (page intro, before the first heading; nearest normative section `#how-it-works-in-the-browser`)
> — "In the [built-in browser](https://learn.chatgpt.com/docs/browser) in the ChatGPT desktop app,
> ChatGPT Work and Codex can discover and use these tools when they are available."

We ship exactly that built-in browser: `apps/electron/src/main/browser-pane-manager.ts`,
`apps/electron/src/main/browser-cdp.ts`, and the model-facing `browser_tool`
(`packages/session-tools-core/src/tool-defs.ts`).

**Measured absence, with a positive control on the same probe run**
(`git grep -a` over `packages apps scripts`, excluding `node_modules`, `.references`, `release`,
`apps/electron/resources`, `codex-protocol/{schema,generated}`, `dist`):

```
webmcp        files=0        browser_tool  files=40   <- positive control
WebMCP        files=0        BrowserCDP    files=4    <- positive control
site tools    files=0
siteTools     files=0
```

**Verdict: take the contract. Kind: never looked at. Cost:** unknown and potentially large — this is
a page-side tool-discovery protocol, so it means teaching `browser-pane-manager.ts` to discover
page-declared tools and surfacing them to the model alongside `browser_tool`. The page also pins a
model requirement ("Use GPT-5.6 Sol or GPT-5.6 Terra for site tools"), and our fallback catalogue
stops at `gpt-5.5` (`packages/shared/src/config/llm-connections.ts`) — so a spike belongs before an
estimate. **Recommend a spike row, not a build row.**

Note the interaction with map row 18 (`browser`), which measured that `browser_tool` does not reach
the codex runtime at all: if that holds, site tools would be a Pi/Claude-only capability on our host
even once built. Confirm row 18 before sizing this.

### 1.2 `developer-settings` — half ours, and it names a contract we already know we do not take

> `learn.chatgpt.com/docs/developer-settings.md#code-review` — "Under **Settings > Git**, use **Review delivery** to choose
> **Inline** to run `/review` in the current chat when possible or **Detached** to start a separate
> review chat."

Measured: `ReviewDelivery` / `reviewDelivery` = **0 files** at HEAD (same probe run, same controls).
This is the same `ReviewDelivery` that map row 26 (`code-review`) found in our pinned protocol schema
and never called — and the plan already records `Dev-9` ("codex-native `thread/goal/*` and
`review/start`: host implementations keep the three runtimes uniform"). **So the Review-delivery half
is already dispositioned; do not re-file it.** What is NOT dispositioned is the rest of the page:
project/terminal behaviour and command-output limits in settings. **Verdict: take the contract
(partial). Kind: never looked at.** Cost: small — a settings audit, no protocol work.

### 1.3 `developer-commands` — a CLI reference, but it documents two things we now do

Our host drives `codex app-server` over stdio JSON-RPC and never invokes the CLI, so most of this
page is not our surface. Two sections are not "most of it": `### codex execpolicy` (we now emit
execpolicy `prefix_rule` files, P3.1 ✅ `7bc247a87`) and `### codex sandbox` with its per-OS
subsections (macOS seatbelt / Linux Landlock / Windows). **Verdict: record the divergence as
deliberate** (we drive the app-server, not the CLI) **with the execpolicy and sandbox sections read
first** — they are the two places where a CLI-reference sentence can still describe the engine we configure. Kind: never looked at. Cost: read-only, one page.

### 1.4 Two that are genuinely not ours — recorded, not dismissed

- `enterprise/chatgpt-work-cloud-security` — **not our surface.** Its whole subject is where *cloud*
  tasks execute, the cloud browser, and workspace retention. We have no cloud tier; our upstream is
  the Nestor gateway through a loopback adapter. Same reasoning the map applies to `cloud`,
  `cloud/internet-access` and `environments/cloud-environment` (all ⛔).
- `security/cli/ci/gitlab` — **not our surface.** It is the Codex Security **CLI** in a GitLab
  pipeline (`codex exec`, `codex plugin add`), which is the half map rows 116/117 already call
  not-ours because we drive `codex-app-server` and install plugins through
  `packages/shared/src/marketplace/service.ts`. Worth one sentence to the owner anyway: this repo IS
  a GitLab shop (`.gitlab-ci.yml`), so the page is interesting as *our own* CI option even though it
  places no obligation on the product.

### 1.5 Two counting artefacts, both harmless, both worth fixing once

- `scripts/codex-doc-pages.tsv` says `139 pages` and has 139 data lines, but only **138 unique
  slugs**: `windows/windows-app` appears twice. The map faithfully mirrors it — rows **11 and 137 are
  the same page**, byte-identical subject and verdict. So the map's "139 rows" is 138 pages plus one
  duplicate, and its "every page gets a row" claim does hold. The duplicate came from upstream's own
  index; nothing was mis-measured. `[doc:none]`.
- Refreshing the TSV moves the denominator, exactly as it does for the Claude corpus. Whoever
  refreshes it should expect the map to go from 138 rows to 143.

---

## 2. The map's ⏸ rows are all resolved, and Phase 3 closed most of the 🟥

Cross-checked against the plan tracker at HEAD, because it changes what is left rather than what is
known:

- **All three ⏸ rows are resolved.** Rows 3 (`agent-approvals-security`) and 102
  (`sandboxing/auto-review`) were parked on the auto_review cluster → **P3.2 ✅**
  (`384e2fb38` + `7736e32a9`). Row 17 (`automations`) was parked on Phase 1 scheduling → **T1–T14 all
  ✅**. Nothing is still parked; the map's `⏸ 3` line is stale.
- **Phase 3 is essentially complete** — P3.1 through P3.31, with only P3.7 (WSL spike), P3.8
  (codex-security home persistence), P3.21 and P3.23 open. That is why so many map cells no longer
  describe HEAD.
- **Of the twelve 🟥, seven have a closed home**: P3.1 ✅ (row 5), P2.10 ✅ (53), P2.9 ✅ (80),
  P3.6 ✅ (65), P0.6 ✅ (78), plus 8/28/100 answered by Dev-5/Dev-6/Dev-7. Open: P3.7 ⬜ (139 WSL),
  P3.8 ⬜ (118 deep-scans), and row 81 (`integrated-terminal`), whose home is the Dev-4 deferral —
  see §0.3.

**What this means for the sweep's size.** The 🟥 column is largely spent. The remaining work in this
map is the 🟨 column — features we built without ever reading the page that governs them — plus the
five uncovered new pages in §1. That is the honest answer to "how big is what remains", and it is
smaller than the map's headline numbers suggest.

---

## 3. A measured trap this sweep hit, worth adding to the traps file

**A `git grep` hit count is a MENTION count, not a USE count — and on this codebase the difference is
not marginal.** Measured while cross-checking one lane's app-server method inventory: of the names it
reported as "present at HEAD", five were not uses at all.

| Name | What the hit actually was |
| --- | --- |
| `process/spawn` | `PiAgent.ensureSubprocess/spawnSubprocess` in a pi-agent-server test fixture — a pure **substring false positive**, unrelated to the app-server method |
| `plugin/install` | a comment in `packages/codex-agent-server/src/app-server-client.ts:80` listing long operations |
| `command/exec` | a comment in `backend/codex/event-adapter.ts:496` using it as a positive-control example |
| `thread/read` | a comment in `codex-agent.ts:2521` recording a **known limit** (`thread/read` answers `turns: []`) — i.e. evidence we deliberately do NOT rely on it |
| `mcpServerStatus/list` | a comment in a test file |

Why this matters more here than usual: this codebase's comments are unusually dense with contract
citations and recorded decisions, so grepping for a contract term hits the *discussion* of the
contract at least as often as its implementation. A sweep that counts hits will systematically
over-report coverage — which is the exact direction of error that makes a gap disappear.

**Rule:** for anything reported as implemented, point at the line that CALLS, WRITES or HANDLES it.
For anything reported as absent, keep the positive control AND check the hit is not a comment that
already records the decision — "we deliberately do not do this, and said so" is a third verdict,
distinct from both "built" and "never looked at". `[doc:none]` — this is method, not contract.

---

## 4. The triaged list

**Method.** The map's 60 gap rows (48 🟨 + 12 🟥) were split across six read-only auditors, each
given: the map cell, the page's Markdown, the page's **real** `id="…"` anchors (extracted by curling
the rendered page, never derived from a slug rule), a byte-honest probe script (`git grep -a` with
the bundled/generated trees excluded), and a standing instruction that every absence claim carries a
positive control on the same run. Row 90 I did myself (§0.1). The five new corpus pages I did myself
(§1). Mid-flight, all six were sent the mention-vs-use correction in §3.

Each entry carries the four things the brief asks for: **verdict**, **kind**, **cost**, **citation**
(`<page>.md#<section>` + verbatim sentence), plus a `HEAD-STATUS` line saying whether the map still holds.

### 4.1 Headline severities across all lanes, ranked

Each of these was measured at HEAD by a lane and, where marked, independently re-checked by me. They
are ordered by *how soon it bites a real user*, not by how large the fix is.

1. **Row 90/101 — the codex permission profile is inert.** §0.1. A credential-read deny that fails in
   the position where it is supposed to work. `bug`. **The live confirmation has not been run.**
2. **Row 16/32 — `CODEX_CA_CERTIFICATE` is never set, and this deployment sits behind corporate TLS
   interception.** `packages/codex-agent-server/src/runtime-manager.ts:139-147` (commit `79a9968ca`,
   2026-08-27) now *records the diagnosis in a comment* — the codex binary reads only
   `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE`, so the bundled `NODE_EXTRA_CA_CERTS` the app already
   ships is **inert for it**. Behind the MITM, codex trusts the OS store or nothing while every other
   runtime works. Diagnosed, unfixed, ~15 lines. `forgotten vs doc-parity`. **This is the most likely
   of the whole list to be a live user complaint today.**
3. **Row 62 — a shipped model default retires in three days.**
   `PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = ['gpt-5.4-mini']` (`llm-connections.ts:870`) is a
   ONE-element list, and the page retires `gpt-5.4` on **2026-08-31**. The file's own rule silently
   skips an unresolvable candidate, so the pick degrades to nothing. `gpt-5.6` = 0 files; no
   replacement exists. `bug`, with a date on it. **And the map's own probe missed this** — it
   recorded "`gpt-5.4` = 0 files, the retirement doesn't break us"; at HEAD it is 6 files.
4. **Rows 85/117 — every codex turn silently downgrades reasoning effort.**
   `config-writer.ts:236-243` maps `xhigh → high` and `max → high`, while codex's own schema takes an
   open string. Two levels capped, no warning. `bug`. **NOT-MEASURED and blocking a fix:** whether any
   gateway model actually advertises `xhigh` — widening blind could turn a silent downgrade into a
   spawn failure.
5. **Row 79 — a dropped screenshot is silently discarded on codex.** The composer advertises
   `images: 'per-model'` for `codex-runtime` while `CodexAgent.chatImpl` declares `_attachments` and
   never reads it. The honest two-line fix is to stop advertising it. `bug`.
6. **Row 89 — "Full access" is not expressible on codex, and that is undocumented.**
   `bypassPermissions` emits the same sandbox/approval pair as `default`. The sandbox-OFF collapse of
   six modes *is* recorded in `runtime-capability-gaps.md`; this one is not.
7. **Row 13 — three surfaces we depend on are absent from the published page.**
   `thread/approveGuardianDeniedAction`, `item/autoApprovalReview/started`, `.../completed` — all
   `grep -c` = 0 against the page's own Markdown. They were taken off the binary and are watched only
   by a schema drift-guard. **This is the same class as this fork's two shipped rename bugs**
   (`Task`→`Agent`, `lsp`→`lspServers`).
8. **Row 4 — two disagreeing project-doc readers.** Codex does its own walk from `cwd` (override file
   wins, 32 KiB cap) while our collector reads a different file set uncapped. A repo carrying
   `AGENTS.override.md` silently steers codex differently from Pi and Claude.
9. **Row 37 — `CDX-ROLES` has been BLOCKED for seven days** (`cdp-live-checklist.md` row `CDX-ROLES`). Rig-fixture
   loss, not a product failure — so the subagent layer is built, unit-tested (32 tests) and
   **unproven live**. Distinguishing those two is the point.
10. **Row 118 — deep-scan tuning is unreachable by construction.** The page puts the file at
    `$CODEX_HOME/codex-security/config.toml`; our `CODEX_HOME` is an ephemeral `mkdtemp` deleted on
    teardown and on every permission-mode change. Defaults are `workers=4 × subagents=3` against an
    Electron fd floor of 256 — a risk, not yet a measured defect.


### 4.2 The whole list at a glance

65 entries: the map's 60 gap rows (48 🟨 + 12 🟥) plus the 5 corpus pages no row covers.
Verdict/kind shown is the row's **primary**; 8 rows split their verdict and 5 split their kind, and
both are written out in the row's own entry rather than flattened here.

| Row | Page | Map | Verdict | Kind | Lane |
| --: | :-- | :-: | :-- | :-- | :-: |
| 4 | `agent-configuration/agents-md` | 🟨 | take | forgotten | A |
| 5 | `agent-configuration/rules` | 🟥 | take (split: +record) | bug | A |
| 7 | `agent-configuration/subagents` | 🟨 | record | forgotten | A |
| 8 | `amazon-bedrock` | 🟥 | record | never-looked-at | A |
| 13 | `app-server` | 🟨 | take (split: +record +not-ours) | forgotten (+never-looked-at) | A |
| 15 | `artifacts-viewer` | 🟨 | take | forgotten | A |
| 16 | `auth` | 🟨 | take (split: +record) | bug | A |
| 18 | `browser` | 🟨 | take | forgotten | A |
| 20 | `build-skills` | 🟨 | take (split: +record +not-ours) | forgotten (+never-looked-at) | A |
| 26 | `code-review` | 🟨 | take | forgotten | B |
| 27 | `codex-sdk` | 🟨 | take | forgotten | B |
| 28 | `computer-use` | 🟥 | not-ours | never-looked-at | B |
| 29 | `config-file/config-advanced` | 🟨 | take | forgotten | B |
| 30 | `config-file/config-basic` | 🟨 | record | forgotten | B |
| 31 | `config-file/config-reference` | 🟨 | take | forgotten | B |
| 32 | `config-file/environment-variables` | 🟨 | take | forgotten | B |
| 33 | `config-file/config-sample` | 🟨 | record | forgotten | B |
| 37 | `customization/overview` | 🟨 | take | bug | B |
| 38 | `customization/memories` | 🟨 | record | forgotten | B |
| 40 | `cyber-safety/recommended-configuration` | 🟨 | take | forgotten | C |
| 43 | `enterprise/admin-setup` | 🟨 | record | forgotten | C |
| 53 | `enterprise/manage-app-updates` | 🟥 | take | bug | C |
| 54 | `enterprise/managed-configuration` | 🟨 | take | forgotten | C |
| 55 | `enterprise/apps-and-connectors` | 🟨 | record | never-looked-at | C |
| 59 | `enterprise/skills` | 🟨 | take (split: +not-ours) | forgotten | C |
| 62 | `enterprise/workspace-model-availability` | 🟨 | take | bug | C |
| 64 | `environments/modes` | 🟨 | take (split: +not-ours) | forgotten | C |
| 65 | `environments/local-environment` | 🟥 | take | forgotten (+never-looked-at) | C |
| 66 | `environments/git-worktrees` | 🟨 | take | forgotten | C |
| 67 | `extend/mcp` | 🟨 | take | forgotten | C |
| 75 | `glossary` | 🟨 | not-ours | never-looked-at | D |
| 78 | `image-generation` | 🟥 | record | bug | D |
| 79 | `image-inputs` | 🟨 | take | forgotten | D |
| 80 | `import` | 🟥 | take | bug (+forgotten) | D |
| 81 | `integrated-terminal` | 🟥 | record | forgotten | D |
| 83 | `long-running-work` | 🟨 | take | forgotten | D |
| 85 | `models` | 🟨 | take | forgotten | D |
| 87 | `notifications` | 🟨 | take | forgotten | D |
| 89 | `permission-modes` | 🟨 | take | forgotten | D |
| 90 | `permissions` | 🟨 | take | bug | me |
| 91 | `personalize` | 🟨 | take | forgotten | D |
| 95 | `projects` | 🟨 | take | bug | E |
| 96 | `prompting` | 🟨 | take (split: +record) | forgotten | E |
| 98 | `reference/troubleshooting` | 🟥 | not-ours | never-looked-at | E |
| 100 | `remote-connections` | 🟥 | record | never-looked-at | E |
| 101 | `sandboxing` | 🟨 | take | bug | E |
| 110 | `security/plugin` | 🟨 | record | never-looked-at | E |
| 113 | `security/plugin/fix-findings` | 🟨 | not-ours | never-looked-at | E |
| 115 | `security/plugin/security-hardening` | 🟨 | not-ours | never-looked-at | E |
| 116 | `security/plugin/code-changes` | 🟨 | not-ours | never-looked-at | E |
| 117 | `security/plugin/scans` | 🟨 | take (split: +not-ours) | bug (+never-looked-at) | E |
| 118 | `security/plugin/deep-scans` | 🟥 | take | forgotten | E |
| 122 | `security/plugin/triage-backlog` | 🟨 | not-ours | never-looked-at | F |
| 124 | `security/plugin/vulnerability-reports` | 🟨 | not-ours | never-looked-at | F |
| 125 | `security-administration` | 🟨 | not-ours | never-looked-at | F |
| 127 | `skills-and-plugins` | 🟨 | record | forgotten | F |
| 135 | `web-search` | 🟨 | record | forgotten | F |
| 136 | `whats-new` | 🟨 | take | never-looked-at | F |
| 138 | `windows/windows-sandbox` | 🟨 | record | forgotten | F |
| 139 | `windows/wsl` | 🟥 | record | forgotten | F |
| — | `webmcp` (NEW page) | — | take | never-looked-at | me |
| — | `developer-settings` (NEW page) | — | take | never-looked-at | me |
| — | `developer-commands` (NEW page) | — | record | never-looked-at | me |
| — | `enterprise/chatgpt-work-cloud-security` (NEW page) | — | not-ours | never-looked-at | me |
| — | `security/cli/ci/gitlab` (NEW page) | — | not-ours | never-looked-at | me |

**Counts.**

| Verdict | Count | | Kind | Count |
| :-- | --: | :-- | :-- | --: |
| take the contract | 38 | | bug (built, built wrong) | 11 |
| record the divergence as deliberate | 16 | | forgotten vs doc-parity | 35 |
| not our surface | 11 | | never looked at | 19 |
| **total** | **65** | | **total** | **65** |

Every one of the 11 `not our surface` verdicts carries its reason in its entry. None was dropped for
being unimportant.

**Tags.** All 60 map rows and all 5 new pages are `[doc:codex]`. Three carry a second tag because the
shipped surface was built to a *Claude* page and the codex page has never been read against it:
row 26 (`code-review` — all 15 in-repo `code-review.md` citations are `code.claude.com`), row 66
(`environments/git-worktrees` — the worktree subsystem's comments cite Claude's `worktrees.md`), and
row 101/90 (`sandboxing`/`permissions` — two codex pages that disagree with **each other**, which is
its own finding: `sandboxing.md` names the legacy vocabulary as *the* vocabulary and never mentions
`default_permissions`, while `permissions.md` is marked Beta and states the precedence rule).
No entry is `[doc:none]` except the three method/tooling findings in §0.3 and §3.

**What this means for the stopping rule.** 60 of 65 entries are `[doc:codex]` rows that count toward
corpus coverage; the sweep therefore moves the plan's stopping rule materially. But note the honest
asymmetry: recording a verdict is not the same as taking the contract, and 38 entries say **take**.

---

## 5. Where I stopped, and what is NOT-MEASURED

**Coverage is complete for the row as scoped.** All 48 🟨 and all 12 🟥 are triaged, plus the 5 pages
the corpus has grown by. Nothing was skipped for being unimportant, and no entry was written that
nobody measured.

**What I deliberately did NOT do:**

- **The 73 ⛔ rows were not re-triaged.** They were out of this row's scope, they carry per-cell
  reasons, and re-deriving them would have cost coverage of the 🟨 column. If the owner wants the ⛔
  column re-checked against HEAD, that is a separate sweep — and worth considering, because this one
  found the map wrong in both directions in the columns it did check.
- **The 3 ⏸ and 3 🟩 rows were checked only for status, not re-triaged** (§2). All three ⏸ resolve.
- **No live run.** This row is read-only. Every conclusion below marked NOT-MEASURED needs an
  executed session, and the most important one gates the severe finding.

**The NOT-MEASURED list, consolidated. These are the honest holes:**

| # | What is unmeasured | Which entry it blocks | Why it matters |
| --: | :-- | :-- | :-- |
| 1 | Whether the bundled `codex-app-server` (rust-v0.148.0) actually applies the documented `sandbox_mode`-beats-`default_permissions` precedence | **90 / 101** | Gates the severe finding entirely. A doc-derived conclusion plus a code reading is not a measurement. One live turn asking the runtime to read `credentials.enc` settles it. |
| 2 | Whether codex 0.148.0 reads `requirements.toml` from `$CODEX_HOME` (vs only a deployment path) | 90/101 option (b), 54 | Makes option (b) unpriceable. The binary-probe technique **already exists in-tree** with controls — `packages/shared/src/agent/codex-config-requirements.ts`. |
| 3 | Whether any gateway model advertises `xhigh` reasoning effort | 85, 117 | A blind widen could turn a silent downgrade into a spawn failure. |
| 4 | Whether `gpt-5.6-terra` / `gpt-5.6-luna` resolve in the shipped Pi catalogue | **62** | Gates the fix for the model default that retires **2026-08-31**. Needs the catalogue, not a grep. |
| 5 | The row-118 fd risk (`workers=4 × subagents=3` against Electron's 256 floor) | 118 | Arithmetic plus a documented in-tree trap, not an executed deep scan. Needs a packaged build. |
| 6 | Whether the pinned binary's `ReasoningEffort` enum even has `xhigh`/`max` members | 85 | Decides whether `xhigh → high` is a gap or a faithful narrowing. |
| 7 | Whether the codex binary reads `.agents/skills` from cwd on its own | 37 | Our projection reaches it via `CODEX_DEFAULT_SKILLS_DIR`; that is enough for the layer to work but is not the same claim. |
| 8 | The `multi_agent = true` vs managed `requirements.toml` `features.multi_agent = false` interaction | 30 | We write a key at its documented default into exactly the table `requirements.toml` constrains. |
| 9 | Whether `elevated` Windows sandbox setup succeeds under our packaging; whether our Linux artefact runs under WSLg with bwrap | 138, 139 | No Windows host on this rig. |
| 10 | Whether the codex app-server resolves a bare `$skill` from user text | 127 | Needs a live install. |
| 11 | Whether the page's `review/start` is the same feature as our shipped `item/autoApprovalReview/*` | 13, 26 | Changes whether row 26(a) is a gap or a duplicate. |

**Two near-misses worth recording as method, not as findings** — both were caught before they entered
the list, and both are the exact shape of error this row exists to avoid:

- A lane's first pass at the app-server inventory counted **mentions** and would have reported five
  methods as implemented that are comments, a test fixture, and one substring false positive (§3).
- A lane read `web_search` going 3 → 34 files as drift; 31 of those hits are **Pi's unrelated search
  tool**. The codex config-writer is still exactly 3 and its test file still 0, so the map stands
  verbatim on that row. A count that moved is not a fact that moved.

---

## 6. What I recommend the owner decide first

Not a priority list for execution — that is the owner's call — but the three decisions that unblock
the most other work:

1. **Row 90/101, and run the live probe before choosing.** Two coherent options (legacy keys complete,
   or profiles complete via `requirements.toml`), and they differ in what happens to the credential
   deny — the legacy schema has no deny form at all. `sandbox-regression.test.ts` is explicitly marked
   "SECURITY PATH — do not simplify away these assertions" and asserts on `sandbox_mode`, so option (b)
   invalidates its premise. **Do not pick a direction on doc reading alone.**
2. **Row 62 has three days on the clock.** Whatever else waits, a shipped one-element model default
   that retires 2026-08-31 and degrades silently should not.
3. **Whether the Codex weekly digest becomes a named corpus in AGENTS.md.** The Claude digest already
   earns that status through parity row R48. Lane F's measurement is the argument: we pin
   `rust-v0.148.0`, **ahead of the newest CLI the digest describes**, so every open item ships inside
   our binary and is simply never called — **~22 of the pinned schema's 159 wire methods are wired,
   about 14%**. The cheapest durable artefact is a checked-in list of those 159 methods with ours
   marked, so the next pin bump diffs mechanically instead of by hand.

---

## 7. The per-row entries

Six lane files, verbatim, each with its own HEAD SHA (all six lanes measured after `f58f66a36`; the
tree moved five times during this audit and each lane recorded where it stood). Row 90 is in §0.1 and
the five new pages are in §1.


---

# LANE A — codex coverage-map re-triage at HEAD

Audited SHA in brief: `f58f66a36f6314384fef1d4c535f7772dd0ca84b`.
**HEAD when I measured: `b1824c4b4334256bc678cf6e932bac81e9d1b222`** (moved; six lanes commit concurrently).
All probes: `git grep -a -I` over `packages apps scripts`, excluding `node_modules`, `.references`,
`release`, `apps/electron/resources`, `packages/codex-protocol/{schema,generated}`, `dist`.
Positive controls on every absence run: `sandbox_mode` = 6 files, `CODEX_HOME` = 27, `SKILL.md` = 150,
`AGENTS.md` = 139, `env_key` = 2, `NODE_EXTRA_CA_CERTS` = 19.

**Note on the map's own numbers:** several map counts (`sandbox_mode` = 70, `thread/start` = 32) were
taken with a WIDER path set than `probe.sh` uses. My counts are not comparable to the map's counts —
only the zero/non-zero verdicts are. I never treat a count difference alone as drift.

---

## Row 13 — `app-server` (🟨) — THE BIG ONE, and the map is materially STALE

**HEAD-STATUS: `map STALE: 9 called methods → 15; config/value/write + configRequirements/read + thread/backgroundTerminals/{list,terminate} + config/mcpServer/reload all landed after 2026-08-22 (d9e5bb112, 57a84ccdc, 3a6cef117, 0c98c9349, bf6d8434c, 44b7eadab)`**

Method inventory rebuilt from the page's own 147 `x/y`-shaped tokens, then classified by CALL SITE,
not by mention (a peer lane correctly flagged that my first pass was a mention inventory — this is
the re-derived one). Absence of the remaining 108 verified in ONE combined `git grep -a -F -l -e …`
pass: only two files matched, and both matches were the substring `tool/requestUserInput` inside
`item/tool/requestUserInput`. So 108 names are genuinely 0.

### CALLED — client→server request, production (15, was 9)
| Method | Site | New since map? |
| --- | --- | --- |
| `initialize` | `codex-agent.ts:1317` | no |
| `thread/start` | `:1381`, `:2432` | no |
| `thread/fork` | `:2405` | no |
| `thread/inject_items` | `:2563` | no |
| `thread/compact/start` | `:2857` | no |
| `turn/start` | `:2892` | no |
| `turn/steer` | `:3184` | no |
| `turn/interrupt` | `:3301`, `:3326` | no |
| `fuzzyFileSearch` | `:2942` | no |
| **`config/value/write`** | `:1014` | **YES** |
| **`config/mcpServer/reload`** | `:1023` | **YES** |
| **`configRequirements/read`** | `codex-config-requirements.ts:71` const, requested `:274` | **YES** |
| **`thread/backgroundTerminals/list`** | `:1698` (paged, deadline-bounded) | **YES** |
| **`thread/backgroundTerminals/terminate`** | `:2998` (behind a drift seatbelt) | **YES** |
| **`thread/approveGuardianDeniedAction`** | `:3105` | **YES — and NOT ON THE PAGE** |

### HANDLED as server→client notification (12)
`item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/completed`, `item/started`,
`thread/compacted`, `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`,
`turn/completed`, `turn/started` — plus **`item/autoApprovalReview/started`** and
**`item/autoApprovalReview/completed`**, which are also **NOT ON THE PAGE**
(all `case '…'` arms in `packages/shared/src/agent/backend/codex/event-adapter.ts`).

### HANDLED as server→client REQUEST — `approval-bridge.ts` (6)
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`, `item/tool/call`,
`mcpServer/elicitation/request`.

### MENTIONED-ONLY — a comment, no call and no handler (8). Not taken contracts; several are recorded decisions
- `thread/resume` — `codex-agent.ts:2400` records deliberate non-use ("app-server intentionally ignores config overrides when `thread/resume`"). **Map correct.**
- `thread/read` — `codex-agent.ts:2521` records a KNOWN LIMIT (`turns: []`), i.e. evidence we do NOT rely on it. **Map correct.**
- `thread/backgroundTerminals/clean` — `codex-agent.ts:1637` "IS DELIBERATELY NOT CALLED".
- `attestation/generate` + `account/chatgptAuthTokens/refresh` — `approval-bridge.ts:487-500` records a deliberate NON-answer: both response schemas are all-required credential strings, so a forgeable frame is refused by returning `null`, and `initialize` sends `requestAttestation: false`. This is the ONE part of the page's `## Auth endpoints` block we have looked at, and the decision is sound.
- `command/exec` — `event-adapter.ts:496`, a positive-control example.
- `plugin/install` — `app-server-client.ts:80`, a long-operation example.

### TEST-ONLY (2) — `openai/form`, `mcpServerStatus/list`. FALSE-POSITIVE SUBSTRING (2) — `process/spawn` (a pi-agent-server fixture's `spawnSubprocess`), `tool/requestUserInput`.

### STILL ABSENT — 108 names, 0 in our source. The map's absent list holds EXCEPT the two it got wrong
Still 0: `thread/list|archive|delete|rollback|items/list|turns/list|loaded/list|unsubscribe|unarchive|metadata/update|name/set|shellCommand`, **all four `thread/goal/*`**, `model/list`, `skills/list|config/write|extraRoots/set|changed`, `hooks/list` + `hook/started|completed`, every `plugin/*` and `marketplace/*`, every `app/*`, every `command/exec/*` sub-method, every `process/*`, `review/start`, `config/read`, `config/batchWrite`, every `fs/*` (11), `windowsSandbox/setupStart|setupCompleted`, `permissionProfile/list`, `collaborationMode/list`, `experimentalFeature/*`, `externalAgentConfig/*`, `environment/info`, `modelProvider/capabilities/read`, `feedback/upload`, `serverRequest/resolved`, `turn/diff/updated`, `turn/plan/updated`, every `item/reasoning/*` delta, `item/plan/delta`, `item/fileChange/outputDelta`, and the whole `## Auth endpoints` `account/*` block (13).

**Two severity notes, one line each:**
1. **PROTOCOL-DRIFT RISK.** Three surfaces we DEPEND ON are absent from the published page (`grep -c` on the local `.md` = 0 for each): `thread/approveGuardianDeniedAction`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`. They were taken off the binary, exactly the category that produced this fork's two shipped rename bugs (`Task`→`Agent`, `lsp`/`lspServers`) — and a page-diff sweep will never see them move.
2. `thread/goal/*` is 0 despite `6b05d4c7a feat(agent): goal runs on every runtime` — the goal is host-side and rides the callback bridge, so codex's own goal store is never written. Two goal states can exist for one thread. Deliberate (P2.2) but worth a row.

- **VERDICT:** `take the contract` — for `thread/list|read|archive|delete` (the four that give a session picker its history and the only ones a user can feel), and `model/list`. `record the divergence as deliberate` for `thread/resume`, `thread/backgroundTerminals/clean`, the `account/*` auth block, and `thread/goal/*`. `not our surface` for `fs/*`, `process/*`, `command/exec/*`, `windowsSandbox/*`, `marketplace/*`, `app/*`, `externalAgentConfig/*`, `feedback/upload` — those serve a host that IS the Codex desktop app; we are a different host with our own filesystem, terminal and update surfaces already built.
- **KIND:** mixed — `forgotten vs doc-parity` for the thread-store four and `model/list`; `never looked at` for `review/start`, `permissionProfile/list`, `collaborationMode/list`, `experimentalFeature/*`, `modelProvider/capabilities/read`, `hooks/list`, `skills/list`, `plugin/*`.
- **COST:** thread-store four ≈ `codex-agent.ts` + a new reader in `packages/codex-agent-server/src/app-server-client.ts`, 150-250 lines + ~6 tests; depends on the session-store shape in `packages/server-core/src/sessions/`, and `thread/read` is already recorded as answering `turns: []`, so history would still have to come from our own store — that recorded limit is most of the argument for `record the divergence as deliberate` instead. `model/list` ≈ 60 lines against the existing `model-fetchers` seam. `review/start` unknown (we shipped a DIFFERENT auto-review surface, `item/autoApprovalReview/*`, and never probed whether `review/start` is the same feature).
- **CITATION:** `learn.chatgpt.com/docs/app-server.md#api-overview` — "`thread/list` - page through stored thread logs; supports cursor-based pagination plus `modelProviders`, `sourceKinds`, `archived`, `isPinned`, `cwd`, `useStateDbOnly`, `searchTerm`, and experimental `parentThreadId` or `ancestorThreadId` filters."
- `[doc:codex]`

---

## Row 18 — `browser` (🟨) — the map's OUTCOME survives, its REASON does not

**HEAD-STATUS: `map STALE: the stated blocker no longer exists. a3e8c7a52 + P3.13 built a per-session host-callback bridge for codex, and one executionMode:'backend' tool (advisor_consult) already crosses it. browser_tool stays absent by omission from a list, not by architecture.`**

Measured at HEAD:
- `browser_tool` is still `executionMode: 'backend'`, `handler: null` (`packages/session-tools-core/src/tool-defs.ts:1145`) and still in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` (`:1293`). Still not advertised to codex — pinned by `packages/session-tools-core/src/scheduling-projection.test.ts:312` (`expect(codexAdvised().has('browser_tool')).toBe(false)`).
- **What changed:** `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` (`:1365`) now carries eight tools over `--host-callback-port`, and `SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK` (`:1395`) carries `advisor_consult` — a BACKEND tool with no port, whose route is a method on the agent. `HOST_CALLBACK_BRIDGE_ROUTES` (`host-callback-bridge.ts:48`) has 11 routes; codex advertises 18 without a bridge, 26 with, 27 with the advisor.
- So the map's sentence "codex получает session-mcp-server с `--external-standalone-only`, который такие инструменты не анонсирует" describes a filter that now has a documented exception, and `browser_tool` is simply not in either exception set.
- The reason recorded in `runtime-switch-costs.ts:127` for withholding it ("the consult runs on the backend's own `queryLlm`, which an external standalone subprocess does not have") is **the advisor's reason, reused**. It does not fit `browser_tool`, whose dependency is `BrowserPaneManager` — which lives in the SAME host process the bridge already runs in (`apps/electron/src/main/browser-pane-manager.ts`, reachable from `packages/server-core/.../SessionManager.ts` and `RemoteBrowserPaneManager.ts`). The repo half-knows this: `docs/architecture/runtime-capability-gaps.md:99` already says "the callback now has a CHANNEL to an external process, so 'requires a host callback' stopped implying 'absent on Codex'".

- **VERDICT:** `take the contract`
- **KIND:** `forgotten vs doc-parity` — the page's app branch (built-in browser, own profile, on-page annotations, Developer mode/CDP) is fully built for Pi and Claude; only the codex projection is missing, and the mechanism that would carry it shipped five days after the map was written.
- **COST:** real and small. One route (`/browser/tool`) in `packages/session-tools-core/src/host-callback-bridge.ts` (114 lines today, +~15), the matching client arm in `packages/session-mcp-server/src/host-callback-bridge-client.ts` (156 lines, +~20), `browser_tool` added to `SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK` behind its own spawn flag (mirroring `advisorConsultBridge`, since the browser pane is host-state and must not be advertised when there is no pane), the host handler in `SessionManager`, plus the five pinned counts in `scheduling-projection.test.ts` (54/46/18/26/27 → a sixth) and the `runtime-switch-costs.ts` docblock. ≈120-180 lines, 4-6 tests. **Blocked on one product decision, not on code:** whether a codex turn may drive the shared browser profile under the same approval gate `Monitor` got in T2 — that gate is the precedent and the reason this is not a free change.
- **CITATION:** `learn.chatgpt.com/docs/browser.md#developer-mode` — "It gives ChatGPT controlled access to the Chrome DevTools Protocol (CDP)."
- `[doc:codex]`

---

## Row 5 — `agent-configuration/rules` (🟥) — map WRONG at HEAD; built 7bc247a87

**HEAD-STATUS: `map WRONG: prefix_rule = 4 files, execpolicy = 8 files (map claimed 0 for both).`**

Landed: `buildCodexExecpolicyRules` (`packages/codex-responses-adapter/src/config-writer.ts:482`) emits
`prefix_rule(pattern=[…], decision="forbidden")` then `decision="allow")` into `CODEX_HOME/rules/nessy.rules`
(`CODEX_RULES_FILE`, `:532`), fed by `collectExecpolicyAllowPrefixes` / `collectExecpolicyDenyPrefixes`
(`packages/shared/src/agent/permissions-config.ts`) off the durable workspace `permissions.json`.
Token escaping is fail-closed (`execpolicyString`, `:454`). Two test files.

**What of the page is STILL missing — measured, and four of the five already carry a recorded reason:**
1. **`decision="prompt"` is never emitted.** Only `allow` and `forbidden` (`:495`, `:500`). Our DSL's ask tier has no projection, so an "ask" rule reaches codex as nothing at all. **This one has no recorded reason and is the only gap I would call a genuine hole.**
2. `justification` never emitted — the page says Codex "may surface it in approval prompts or rejection messages", so a codex-side refusal names no rule. No recorded reason.
3. `match` / `not_match` never emitted. Recorded reason at `permissions-config.ts:923` — they "validate against raw argv, so neither can demonstrate wrapper behaviour".
4. `codex execpolicy check` — recorded as **absent from our shipped artifact**, driven 2026-08-25: `execpolicy` → "error: unexpected argument 'execpolicy' found". An upstream/artifact fact, not our gap.
5. Durable user layer `~/.codex/rules/default.rules` = 0 hits. Deliberate: `CODEX_HOME` is an ephemeral `mkdtemp`, the durable store is `permissions.json`, and the rules file is a pure projection rewritten per home build (`:113-115`).
6. `<repo>/.codex/rules/` trusted project layer and the Team Config layer: not read. "Smart approvals … may propose a `prefix_rule`" = 0.

The whole projection is explicitly **defence in depth, not a floor** (`permissions-config.ts:910-925`), measured: one malformed rule drops every rule in the file, and codex does not split a wrapped script. The enforcing floor stays in `core/pre-tool-use.ts`. That is the right call and it is written down.

- **VERDICT:** `record the divergence as deliberate` for items 3-6; `take the contract` for items 1-2.
- **KIND:** `bug` — narrowly, for item 1: `permissions-config.ts` reads a three-tier DSL and projects two tiers, silently. An "ask" rule is not merely unprojected, it is indistinguishable from "no rule" on the codex side.
- **COST:** `collectExecpolicyPromptPrefixes` beside the two existing collectors (~30 lines), a third loop in `buildCodexExecpolicyRules` (~6 lines), an optional `justification=` argument on all three (~10 lines), one new option on `CodexConfigOptions`. ≈60 lines + 3 tests in `config-writer-execpolicy-rules.test.ts`. No new dependency; `decision="prompt"` is already driven-and-confirmed on the shipped binary (`permissions-config.ts:904`).
- **CITATION:** `learn.chatgpt.com/docs/agent-configuration/rules.md#understand-rule-fields` — "`prompt`: Prompt before each matching invocation."
- `[doc:codex]`

---

## Row 4 — `agent-configuration/agents-md` (🟨)

**HEAD-STATUS: `map still correct` — `AGENTS.override.md`, `project_doc_fallback_filenames`, `project_doc_max_bytes` all still 0 (positive control `AGENTS.md` = 139).**

Correction to the map's framing, and it raises the severity: the map reports these as three unimplemented
features. Measured, they are worse than unimplemented on the **codex runtime specifically** — they are
**two independent readers of project instructions that disagree**:
- Our host-side collector reads `PROJECT_INSTRUCTION_FILES = ['AGENTS.md','CLAUDE.md','CLAUDE.local.md']`
  (`packages/shared/src/capabilities/native-sources.ts:130`) and is **uncapped on the live path**
  (`:956-960`, "a single layer is routinely 10-15 KB").
- We write no `project_doc_*` key into the codex config (0 hits in `config-writer.ts`), and `cwd` is the
  real workspace, so **codex ALSO does its own walk** with its own rules: `AGENTS.override.md` beats
  `AGENTS.md`, plus fallback names, capped at 32 KiB.

So in a repo that has an `AGENTS.override.md`, a codex session is steered by a file the user's Sources
panel never shows and our own prompt never carries — while Pi and Claude read the overridden file. That
is a silent per-runtime instruction divergence, not a missing feature.

- **VERDICT:** `take the contract`
- **KIND:** `forgotten vs doc-parity`
- **COST:** small if scoped to agreement rather than feature-parity. Add `AGENTS.override.md` to
  `PROJECT_INSTRUCTION_FILES` with codex's precedence (override wins per directory) — `native-sources.ts`
  ~20 lines, plus its registry-of-roots entry at `:995`; and either write `project_doc_max_bytes` to match
  our uncapped read or cap ours to 32 KiB (one line in `config-writer.ts` vs a real behaviour change in
  `native-sources.ts` — **owner call, and I did not measure which is cheaper downstream**).
  `project_doc_fallback_filenames` is a user-config surface we do not have; larger, and I would defer it.
  ≈3-5 tests. **NOT-MEASURED:** whether any real repo in use here has an `AGENTS.override.md` — I did not
  scan user machines, so the live blast radius is unknown.
- **CITATION:** `learn.chatgpt.com/docs/agent-configuration/agents-md.md#how-codex-discovers-guidance` — "In each directory along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`, then any fallback names in `project_doc_fallback_filenames`."
- `[doc:codex]`

---

## Row 7 — `agent-configuration/subagents` (🟨)

**HEAD-STATUS: `map still correct` — the feature is built and the reserved-key set still matches the page's Global settings table exactly.**

Re-verified all five `[agents]` keys at HEAD: `agents.enabled` (4 files), `default_subagent_model`,
`default_subagent_reasoning_effort`, `interrupt_message`, `max_concurrent_threads_per_session`
(1 file each = `CODEX_AGENTS_RESERVED_KEYS`, `config-writer.ts:413-418`). `buildCodexAgentRoles`
7 files, `spawn_agent` 10. The page's **Custom agent file schema** three required fields
(`name`, `description`, `developer_instructions`) are all enforced — `config-writer.ts:1100`
pushes `developer_instructions` into `requiredKeys`, `:703` denies a blank one.

One gap the map did not name and I did measure: the page says the legacy alias
`agents.max_threads` is still accepted, and the page's schema note "You can also include other
supported `config.toml` keys in a custom agent file, such as `model`, `model_reasoning_effort`,
`sandbox_mode`, `mcp_servers`, and `skills.config`" — of those five, `skills.config` is 0 in our
source (see row 20), so a role file cannot narrow its own skill surface.

- **VERDICT:** `record the divergence as deliberate` — the feature is taken; the remaining delta is one optional per-role key.
- **KIND:** `forgotten vs doc-parity` (narrow: per-role `skills.config`).
- **COST:** unknown, and honestly so — it depends on row 20's `[[skills.config]]` work landing first; on its own it is ~15 lines in `buildCodexAgentRoles`.
- **RISK NOTE (unchanged from the map, and I agree with it):** the whole feature was reverse-engineered from the bundled binary's `config-schema.json`, not from this page. The drift-guard at `__tests__/config-writer-agent-roles.test.ts:205-215` watches the SCHEMA, not the DOC. This is the same exposure as row 13's three undocumented methods.
- **CITATION:** `learn.chatgpt.com/docs/agent-configuration/subagents.md#global-settings` — "Existing configurations can keep using `agents.max_threads` as a legacy alias."
- `[doc:codex]`

---

## Row 8 — `amazon-bedrock` (🟥)

**HEAD-STATUS: `map still correct` — and I re-confirmed the map's central catch, which was the hard part of this row.**

`AWS_BEARER_TOKEN_BEDROCK` = 3 files, and **all three are Claude-side**:
`packages/shared/src/config/claude-provider-routing-env.ts:18,37` and
`packages/shared/src/config/managed-env.ts:155` — i.e. `code.claude.com/docs/en/amazon-bedrock.md`,
a different page with the same slug. On the codex path: `openai.gpt-5` = 0, `~/.codex/.env` = 0,
and `model_provider` is unconditionally our loopback (`config-writer.ts:771,797-801`).

- **VERDICT:** `record the divergence as deliberate`
- **KIND:** `never looked at`
- **COST:** unknown, and I will not guess. The page's own desktop-app instruction is `~/.codex/.env`, which is a file in the DURABLE codex home — and our `CODEX_HOME` is an ephemeral `mkdtemp` per session, so the documented mechanism does not exist for us at all. Any implementation is a new BYO-endpoint arm, not an env-var passthrough; that line already exists separately (`docs/superpowers/plans/2026-08-04-codex-byo-endpoints.md`) and is where this belongs.
- **Why deliberate rather than a gap:** the gateway is the product's model path; Bedrock is a customer-BYO story with no internal demand I can see. But it IS applicable — the page's subject is "local ChatGPT Work and Codex surfaces", which is exactly the client we embed — so it should be a written-down deviation, and it currently is not (0 mentions in the deviation register per the map; I did not re-count that, see NOT-MEASURED below).
- **CITATION:** `learn.chatgpt.com/docs/amazon-bedrock.md#desktop-app-and-ide-extension` — "Desktop apps and IDE extensions may not inherit environment variables from the shell."
- `[doc:codex]`
- **NOT-MEASURED:** I did not re-run the deviation-register count (the map's "отклонение не записано"); the brief told me the citation census is settled and I took that, but the REGISTER is a different file from the citation census.

---

## Row 15 — `artifacts-viewer` (🟨) — one map claim is imprecise

**HEAD-STATUS: `map WRONG (partially): the cell says "HTML-превью с переключением rendered↔source тоже нет". HTML preview EXISTS — MarkdownHtmlBlock.tsx + HTMLPreviewOverlay.tsx, both present since the 1.0.1 baseline (845cf0a41), so this was already wrong when the map was written, not drift. Only the rendered↔source TOGGLE is missing. MarkdownDocBlock.tsx (markdown-preview) also exists and the map does not mention it.`**

The map's real finding survives and I re-confirmed it byte-for-byte at HEAD:
`packages/ui/src/lib/file-classification.ts` — `FilePreviewType` is still
`'image'|'code'|'markdown'|'json'|'text'|'pdf'` (`:10`), and `EXTERNAL_EXTENSIONS` still holds
`xlsx/xls/xlsm/docx/doc/pptx/ppt`, so `classifyFile` returns `canPreview: false` and the system
opener takes them. `.html` classifies as `code` (`:38`), i.e. source-only through that path.

So: the page's two verbs are half-covered. **Refine-with-annotations is fully built**
(`packages/ui/src/components/annotations/`). **Preview is built for PDF, spreadsheets-as-a-block,
HTML and markdown, but NOT for the three formats the page names as first-class when they arrive as
a FILE LINK** — a generated `.xlsx` or `.docx` in a chat opens in Excel/Word, not beside the chat.

- **VERDICT:** `take the contract`
- **KIND:** `forgotten vs doc-parity`
- **COST:** the spreadsheet renderer already exists (`MarkdownSpreadsheetBlock.tsx`), so `xlsx` is
  mostly wiring: a `'spreadsheet'` member on `FilePreviewType`, moving `xlsx/xls/xlsm` out of
  `EXTERNAL_EXTENSIONS`, and an overlay that reuses the existing grid — ≈80 lines + 2 tests.
  `docx`/`pptx` are a genuinely new renderer and I have **no basis for a number**: unknown, and it
  needs a library decision (nothing in-tree renders either format).
- **CITATION:** `learn.chatgpt.com/docs/artifacts-viewer.md#review-and-refine-files` (the CLI branch) — the page's own limit sentence: "…include a visual file preview or annotation interface." (page intro's fuller claim, "The ChatGPT desktop app previews generated documents, presentations, spreadsheets, and PDF files alongside the chat", sits BEFORE the first heading — cited here against the nearest normative section, and I am naming that.)
- `[doc:codex]`

---

## Row 16 — `auth` (🟨)

**HEAD-STATUS: `map STALE (cosmetically): CODEX_CA_CERTIFICATE went 0 → 1 file. The one hit is a COMMENT, not an implementation — P2.213 in packages/codex-agent-server/src/runtime-manager.ts:140-147, measured 2026-08-27. The gap is unchanged; it is now diagnosed.`**

That comment is worth quoting because it converts the map's guess into a measurement: the codex
binary's trust store "reads exactly two variables — `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` — and
otherwise logs 'using system root certificates because no CA override environment variable was
selected'". It also establishes that our bundled `NODE_EXTRA_CA_CERTS` (`tinkoff-bundle.crt`) is
**INERT** for codex, and it names the consequence plainly: "behind TLS interception codex trusts the
OS store or nothing". The child does inherit `process.env` (`runtime-manager.ts:153`), so the channel
exists and is simply unset.

Everything else the map measured still holds at 0: `requires_openai_auth`, `cli_auth_credentials_store`,
`forced_login_method`, `forced_chatgpt_workspace_id`, `codex login` — and `~/.codex/auth.json` has no
codex-path hit (the two `auth.json` files are a Pi runtime store and a Figma fixture). One of the
page's three provider schemes is implemented: `env_key = "COMPANY_LLM_API_KEY"` (`config-writer.ts:998`).

**Severity: this is the one row in my set with a live corporate-environment failure mode.** A user
behind TLS interception gets a codex runtime that cannot reach anything over TLS, while every other
runtime works, because Node reads our bundle and the Rust binary does not.

- **VERDICT:** `take the contract` (for `CODEX_CA_CERTIFICATE` only). `record the divergence as deliberate` for the OpenAI-auth branch — `requires_openai_auth`/`forced_login_method`/`codex login` presuppose signing in to OpenAI, and our codex talks to a loopback adapter in front of the Nestor gateway, so they are inapplicable by construction.
- **KIND:** `bug` for the CA gap (a shipped, diagnosed, unfixed inheritance hole); `not our surface` reasoning applies to the rest but is written down here rather than withheld.
- **COST:** genuinely small — set `CODEX_CA_CERTIFICATE` (falling back to `SSL_CERT_FILE`) in the `env` object at `runtime-manager.ts:153-157`, sourced from the same place `NODE_EXTRA_CA_CERTS` comes from (`packages/server-core/src/bootstrap/plugin-runtime-dependencies.ts:29-30`). ≈15 lines + 2 tests. The diagnosis is already done; only the wiring and a decision about which bundle path to hand it remain.
- **CITATION:** `learn.chatgpt.com/docs/auth.md#custom-ca-bundles` — "When `CODEX_CA_CERTIFICATE` is unset, Codex falls back to `SSL_CERT_FILE`."
- `[doc:codex]`

---

## Row 20 — `build-skills` (🟨)

**HEAD-STATUS: `map still correct` — every absence re-probed at HEAD and every one still 0.**

`/etc/codex/skills` = 0, `skills.config` = 0, `skill-installer` = 0, `allow_implicit_invocation` = 0,
skill-list budget (`skillsBudget`/`SKILL_LIST_BUDGET`/`skillListBudget`/`maxSkillChars`) = 0.
`openai.yaml` = 1 file and it is the map's own finding re-confirmed — a test that asserts its
ABSENCE (`packages/shared/src/plugins/__tests__/format-adapters.test.ts:1231`,
`expect(...).not.toContain('openai.yaml')`), i.e. we actively strip it. `extraRoots` = 1 and is an
unrelated CDP case variable, not `skills/extraRoots/set`. Positive controls: `SKILL.md` = 150,
`.agents/skills` = 24. REPO and USER scopes remain implemented (`packages/shared/src/skills/storage.ts:33-37`,
priority at `:465-475`); SYSTEM scope is ours (`apps/electron/resources/skills/`).

Ranking the four gaps by what they actually cost a user:
1. **`[[skills.config]] path/enabled`** — a user cannot turn one skill off without deleting it. Also blocks row 7's per-role `skills.config`. Highest value.
2. **The initial-list budget** ("at most 2% of the model's context window, or 8,000 characters when the context window is unknown") — we have NO cap. With 150 `SKILL.md` files in-tree, an unbounded list is a real context cost, and this is the class of thing that is invisible until a long session degrades.
3. `ADMIN` scope `/etc/codex/skills` — matters only for managed fleets; adjacent to the managed work that landed in 3a6cef117.
4. `$skill-installer` — a curated-registry feature with no internal equivalent.

- **VERDICT:** `take the contract` for (1) and (2); `record the divergence as deliberate` for (4) — `openai.yaml` is stripped ON PURPOSE and a test pins it, so the invocation-policy/UI-metadata half of the page is a decision already made, just not written into the register. `not our surface` for (3) unless a managed-fleet requirement appears.
- **KIND:** `forgotten vs doc-parity` for (1) and (2); `never looked at` for (3).
- **COST:** (1) ≈ a `skills.config` reader in `packages/shared/src/skills/storage.ts` plus an `enabled` filter in the priority walk at `:465-475`, ~60 lines + 3 tests; the config file it reads is `~/.codex/config.toml`, which for us is a per-session projection, so **it needs a durable-store decision first — same shape as row 5's `nessy.rules`, and I flag that as the real dependency rather than the line count.** (2) ≈ 30 lines where the skill list is assembled + the context-window number, which `packages/shared/src/model-metadata` already carries; 2 tests.
- **CITATION:** `learn.chatgpt.com/docs/build-skills.md#enable-or-disable-local-codex-skills` — "Use `[[skills.config]]` entries in `~/.codex/config.toml` to disable a skill without deleting it:"
- `[doc:codex]`

---

## Lane-A NOT-MEASURED, collected

- **Row 8:** did not re-count the deviation register; the brief settled the CITATION census, which is a different file.
- **Row 4:** did not measure how many real repos carry an `AGENTS.override.md`, so the live blast radius of the two-reader divergence is unknown.
- **Row 15:** no basis for a `docx`/`pptx` renderer estimate — no in-tree library renders either.
- **Row 13:** did not determine whether the page's `review/start` is the same feature as the `item/autoApprovalReview/*` surface we shipped. They may be one contract, in which case that row is "taken under a different name" rather than absent.
- **Rows 5 and 20:** the two "durable store" questions (`~/.codex/rules/default.rules`, `~/.codex/config.toml` `[[skills.config]]`) are the same question asked twice, and both are blocked on the ephemeral-`CODEX_HOME` decision. I did not try to answer it; it is an owner call and it gates both cost estimates.

---

# Lane B — rows 26, 27, 28, 29, 30, 31, 32, 33, 37, 38

Audited at **HEAD = `b1824c4b4334256bc678cf6e932bac81e9d1b222`** (branch `feat/TCODE-000`).
The brief named `f58f66a36f6314384fef1d4c535f7772dd0ca84b`; HEAD had already moved when this lane
started. Every measurement below is against `b1824c4b`.

Probe discipline: every non-zero count was resolved to a FILE LIST and then to the emitting/reading
LINE. Two hits that a count alone would have scored as "implemented" turned out to be comments and
are reported as comments (`CODEX_CA_CERTIFICATE`, row 32) or as substring false positives
(`[skills]`/`[plugins]`/`[apps`/`[windows]` matching TS array types, row 31). Positive control on
every absence run: `sandbox_mode` = 6 files, `CODEX_HOME` = 27 files, `thread/start` = 18 files.

---

## §0 — THE SHARED KEY INVENTORY (done once, feeds rows 29/30/31/33)

### 0.1 What `buildCodexConfigToml` emits at HEAD

`packages/codex-responses-adapter/src/config-writer.ts:912-1055` (the file grew 994 → **1238** lines
since the map). Emission order, with the line that writes each:

| # | Key | Line | Condition |
| --- | --- | --- | --- |
| 1 | `model` | :932 | always |
| 2 | `model_context_window` | :935 | `contextWindow` given |
| 3 | `model_auto_compact_token_limit` | :940 | derived from the window (`autoCompactTokenLimit`, :873) |
| 4 | `model_reasoning_effort` | :944 | `thinkingLevel` set |
| 5 | `model_provider` = `"nessy_gateway"` | :945 | always |
| 6 | `web_search = "disabled"` | :948 | always |
| 7 | `approval_policy` | :949 | always |
| 8 | **`approvals_reviewer = "auto_review"`** | :953 | **NEW** — setting on AND `approval_policy != "never"` |
| 9 | `sandbox_mode` | :954 | always |
| 10 | `default_permissions` | :956 | a filesystem policy exists |
| 11 | **`[features]` / `multi_agent = true`** | :968-969 | **NEW — always** |
| 12 | **`[auto_review]` / `policy`** | :976 | **NEW** — eligible + non-blank policy |
| 13 | `[shell_environment_policy]` / `exclude` | :980-982 | `poolMcpUrl` set |
| 14 | `[shell_environment_policy.set]` | :987-988 | runtime env non-empty |
| 15 | `[model_providers.nessy_gateway]` / `name`,`base_url`,`wire_api`,`env_key` | :994-998 | always |
| 16 | `[permissions.nessy_runtime]` / `description`,`extends` | :1004-1006 | filesystem policy |
| 17 | `[permissions.nessy_runtime.filesystem]` / `<path> = <access>` | :1008-1009 | filesystem policy |
| 18 | `[mcp_servers.session]` / `command`,`args`,`env` | :1017-1023 | session MCP |
| 19 | `[mcp_servers.sources]` / `url`,`bearer_token_env_var` | :1030-1032 | pool MCP |
| 20 | `[agents.<role>]` / `description`,`config_file` | :1047-1049 | per role, LAST |

Sibling files `writeCodexConfig` (:1209-1233) writes into the same `CODEX_HOME`:
- `agent-roles/<role>.toml` — carries top-level **`developer_instructions`** (:730)
- **`rules/nessy.rules`** (:1229) — execpolicy `prefix_rule(pattern=[…], decision="allow"|"forbidden")`
  (:495, :500). **NEW since the map** (commit `7bc247a87`).

### 0.2 THE MAP'S BIGGEST MISS — there is a SECOND config.toml writer, and it always was

The map says, in row 29's cell: «мы единственные, кто пишет codex config.toml: config-writer.ts».
**That is wrong, and it was wrong on 2026-08-22 too** — the second writer's last touch is
`3886fff4c` (2026-07-30), three weeks BEFORE the map.

`packages/server-core/src/pi-harness/isolation/windows.ts` uses the bundled codex binary as the
Windows process sandbox for plugin/MCP children. `ensureProtectedCodexHome` (:176-198) writes:
- `$CODEX_HOME/config.toml` (`BASE_CONFIG`, :26 — a comment line only), and
- `$CODEX_HOME/nessy-<sha256>.config.toml`, a **PROFILE FILE**, selected at :250 with
  `'--profile', configProfile`.

`renderPermissionProfile` (:96-135) emits keys the main writer never touches:
`default_permissions`; `[shell_environment_policy]` `inherit = "all"`, `ignore_default_excludes = true`,
`experimental_use_profile = false`; `[windows]` `sandbox = "unelevated"`, `sandbox_private_desktop = true`;
`[permissions.<n>]` `description`; `[permissions.<n>.filesystem]` `":root"` + per-path; and
`[permissions.<n>.network]` `enabled`.

Consequence: **`profiles` and `[windows]` are NOT unimplemented** (map rows 29/33 say they are), and
`docs/architecture/runtime-control-boundary.md:149` listing `profiles` under "Never evaluated" is
true only if you read that table as scoped to the codex *runtime*, which it does not say.

### 0.3 The denominator, measured from the page

`config-file/config-reference.md` §`config.toml` (lines 1-1650) carries **279 documented entries**:
**53 top-level scalars** + 226 dotted, across **26 distinct table prefixes**. §`requirements.toml`
(1656-2369) carries a further 133 entries.

**We write 11 of the 53 top-level scalars** (the ten above + `developer_instructions` in the role
files) and **8 of the 26 table prefixes** (`features`, `auto_review`, `shell_environment_policy`,
`model_providers`, `permissions`, `mcp_servers`, `agents` from the main writer; `windows` from
`windows.ts`). Every key we write is present in the page — no key we emit is undocumented.

### 0.4 Of the 42 unwritten top-level scalars + 18 unwritten tables, which MATTER for an embedded app-server host

**MATTER (embedded host):**
- `instructions` — our system prompt does not reach codex at all. `runtime-control-boundary.md:142`
  already calls it "the single largest unexercised lever on this runtime". **Highest.**
- inline `[hooks]` + `features.hooks` — `grep -ac 'hooks' config-writer.ts` = **0** at HEAD; the same
  doc line records that this is why codex gets four Nessy hook events instead of the full vocabulary.
- `shell_environment_policy.inherit` / `.ignore_default_excludes` — see the severity line on row 29.
- `sandbox_workspace_write.*` — we set `sandbox_mode` and never the sub-table (writable roots,
  network). For a product whose selling point is the sandbox, this is the loudest silent default.
- `tool_output_token_limit`, `background_terminal_max_timeout` — we shipped background terminals
  (`0c98c9349`) and bound neither.
- `compact_prompt` / `experimental_compact_prompt_file` — codex compacts with its own prompt while Pi
  compacts with ours.
- `[otel]` — enterprise observability for a managed fleet.
- `[memories]` (row 38), `[computer_use.windows]` (row 28), `review_model` (row 26),
  `model_reasoning_summary` / `model_verbosity` (reasoning-stream shaping for a GUI).

**DO NOT matter (CLI/TUI-only or superseded by our own layer):**
`tui.*`, `file_opener`, `disable_paste_burst`, `hide_agent_reasoning`, `show_raw_agent_reasoning`,
`[desktop].custom_file_handlers`, `notify` / `tui.notifications`, `windows_wsl_setup_acknowledged`,
`[feedback]`, `[notice]`, `[tool_suggest]`, `[analytics]`, `chatgpt_base_url`, `openai_base_url`,
`oss_provider`, `model_catalog_json`, `forced_login_method`, `forced_chatgpt_workspace_id`,
`cli_auth_credentials_store`, `mcp_oauth_*` (we run our own auth), `[apps]` (ChatGPT connectors),
`[skills]`/`[plugins]`/`marketplaces` (host-side layers), `[projects]` (we own cwd and trust),
`project_root_markers` / `project_doc_max_bytes` / `project_doc_fallback_filenames` (AGENTS.md
discovery from cwd — defaults are right), `[history]` / `sqlite_home` (moot: ephemeral CODEX_HOME —
and leaving history off is arguably the CORRECT posture, not a gap).

---

## Row 26 — `code-review` 🟨

**HEAD-STATUS:** `map still correct` — every absence re-probed and still 0.
`review/start` = 0, `ReviewStartParams` = 0, `ReviewDelivery` = 0, `review_model` = 0,
`stageHunk`/`stageFile`/`unstageFile`/`Stage all`/`Revert all`/`reviewPane` = 0 (positive controls
`thread/start` = 18, `sandbox_mode` = 6). One near-miss worth naming: `revertFile` = 14 files, but
all fourteen are the session **checkpoint rewind** path (`packages/shared/src/sessions/file-checkpoints.ts`,
`packages/server-core/src/sessions/SessionManager.ts`) — reverting to a session snapshot, not to the
Git index. Different contract; it does not close the page's per-file/per-hunk revert.

**VERDICT:** `take the contract`
**KIND:** `forgotten vs doc-parity`
**COST:** Two separable pieces.
(a) *Detached review delivery* — `review/start { threadId, target, delivery }` is already in our own
bindings and in the shipped binary. Wiring it is `codex-agent.ts` (one request + event routing, the
`thread/start` call site at :533 is the shape to copy) + the `/code-review` skill gaining a codex arm.
Rough: 100-200 lines, 4-6 tests, depends on nothing else. Risk: it would give codex a *different*
review than Pi/Claude get, so it needs an owner call on whether one cross-runtime review is worth
more than a native one.
(b) *Review-pane staging* (stage/unstage/revert at diff / file / hunk) — this is a real feature, not a
wiring gap: `packages/ui/src/components/code-viewer/UnifiedDiffViewer.tsx` +
`MultiDiffPreviewOverlay.tsx` render diffs and have no Git write path at all. Cost **unknown**;
it needs a Git-index RPC surface that does not exist.
(c) `review_model` — one key in `buildCodexConfigToml`, ~5 lines + 1 test.

**CITATION:** `learn.chatgpt.com/docs/code-review.md#staging-and-reverting-files` — "You can stage, unstage, or revert
changes at these levels:" (followed by Entire diff / Per file / Per hunk).

**Note:** the tag is `[doc:codex]+[doc:claude]`. All 15 `code-review.md` occurrences in the repo cite
the **Claude** page (`code.claude.com/docs/en/code-review.md`), so the shipped surface was built to a
foreign contract and this page has never been read against it.

---

## Row 27 — `codex-sdk` 🟨

**HEAD-STATUS:** `map STALE: turn/start now carries outputSchema — commit 5f0f9b244.`

Measured at HEAD, `codex-agent.ts:2892-2910`, `turn/start` carries **three** fields:
`threadId`, `input`, and `outputSchema` (conditional, `...(compiledOutputSchema ? { outputSchema: … } : {})`
at :2910). The map's «наш вызов передаёт ТОЛЬКО `threadId` и `input`» is stale.
`thread/start` (:1204ff) carries `{ cwd, model }`.

Still unused, of `TurnStartParams`' 13 fields: `clientUserMessageId`, `cwd`, `approvalPolicy`,
`approvalsReviewer`, `sandboxPolicy`, `model`, `serviceTier`, `effort`, `summary`, `personality` — ten.
`approvalsReviewer` is the sharpest: it exists on `TurnStartParams` AND we now compute exactly that
value (`buildCodexAutoReviewOptions`, `codex-agent.ts:3833-3840`) — but we route it through
`config.toml` (`approvals_reviewer`, config-writer.ts:953) and therefore through a **re-fork**, when
the same value would ride the turn.

**SEVERITY (doc drift, one line):** `docs/architecture/runtime-control-boundary.md` is now wrong in
two places at HEAD. :149 lists `auto_review` and `review_model` under "Never evaluated" — `[auto_review]`
IS written (config-writer.ts:976, commits `7736e32a9` + `384e2fb38`). :156 says "`turn/start` carries
no config" — narrowly still true (no *config* override), but it is one `outputSchema` away from being
read as false.

**VERDICT:** `take the contract`
**KIND:** `forgotten vs doc-parity`
**COST:** The per-turn override is the whole prize: it replaces `refork` (`codex-agent.ts:2352ff`,
awaited at the head of every turn, bounded by P2.257) for model / sandbox / approval / auto-review
drift. Files: `codex-agent.ts` (the `turn/start` call site + `codexThreadConfigSignature` shrinking to
only the fields that genuinely need a fork), `config-writer.ts` untouched. Rough 150-250 lines,
6-10 tests. **Depends on a drift measurement first**: `TurnStartParams` does NOT declare
`additionalProperties: false`, so an older app-server silently IGNORES an override — the same failure
mode `outputSchema` already documents at :2902-2909, and the same host-side verification would be
needed (there is no equivalent of `withStructuredOutput` for a sandbox override, which is why this is
not a five-line change).

**CITATION:** `learn.chatgpt.com/docs/codex-sdk.md#sandbox-presets` — "A sandbox passed to `run(...)` or `turn(...)` applies
to that turn and later turns on the thread."

---

## Row 28 — `computer-use` 🟥

**HEAD-STATUS:** `map still correct` — `always_allowed_app_ids` = 0, `computer_use` = 0,
`[computer_use` = 0 (positive control `CODEX_HOME` = 27, `sandbox_mode` = 6).

**VERDICT:** `not our surface`
**KIND:** `never looked at`
**Reason, written down rather than left silent:** the page's subject is a **plugin inside the ChatGPT
desktop app** — "Open **Plugins > Computer Use** and select **Install plugin**", an MCP server + skill
pair, requiring macOS Screen Recording and Accessibility grants issued to a bundle named
**"Codex Computer Use"**. Nessy Desktop is a different Electron host with a different bundle id and
different entitlements (`apps/electron/build/entitlements.mac.plist`); a grant to OpenAI's binary
cannot transfer. Nothing on this page is reachable by writing a config key.

The **one** intersection is real and worth recording: `[computer_use.windows] always_allowed_app_ids`
lives in `$CODEX_HOME/config.toml`, and we own that file (`runtime-manager.ts:19`, `:48`;
config-writer.ts:1231). It is inert for us only because we never install the plugin — so this is a
divergence to record, not a fact to forget.

**What DID change at HEAD, and it is on the requirements side:** an administrator's
`requirements.toml` `[features].computer_use = false` is now **read and surfaced**. `readCodexConfigRequirements`
(`packages/shared/src/agent/codex-config-requirements.ts:126-165`) walks every field the server SET
and pushes each one it does not apply onto `unsupported`, so `featureRequirements.computer_use`
reaches the administrator as an explicit "we read this and do not apply it" line rather than silence.

**CITATION:** `learn.chatgpt.com/docs/computer-use.md#permissions-and-approvals` — "On Windows, Computer Use stores
persistent app decisions in `$CODEX_HOME/config.toml`." (The `<ToggleSection title="Configure Windows
app policy">` block sits inside that section and has no id of its own.)

---

## Row 29 — `config-file/config-advanced` 🟨

**HEAD-STATUS:** `map WRONG: profiles ARE implemented, and config-writer.ts is not the only config.toml writer` — see §0.2. `[features]` is also now emitted (§0.1), which the map's «grep -a '[features]' по *.ts = 0» denies.

**SEVERITY (one line, honest):** `[shell_environment_policy]` is written with exactly one key —
`exclude = ["NESSY_CODEX_MCP_POOL_TOKEN"]` (config-writer.ts:982) — and never `inherit` or
`ignore_default_excludes`. The page states the default is permissive: `ignore_default_excludes`
defaults to `true`, so codex does **not** apply its own KEY/SECRET/TOKEN sweep, and `inherit` unset
means the child shell inherits the host environment whole. This is not obviously a defect (a user's
own terminal inherits the same) — but we clearly INTENDED to scope this surface, we scoped exactly one
variable, and the doc names a one-line knob that would scope the rest. Note the second writer takes
the opposite decision deliberately and explicitly: `windows.ts:115-117` writes `inherit = "all"` and
`ignore_default_excludes = true` for the plugin sandbox. Two writers, opposite postures, neither
recorded against this page.

Four of the page's sections ARE implemented, as the map said, and re-verified at HEAD:
§Custom model providers (`config-writer.ts:994-998`), §Named permission profiles (:1004-1009),
§Shell environment policy (:980-991), §Agent roles `[agents]` (:1047-1049), plus
§Config and state locations via `CODEX_HOME` (`runtime-manager.ts:48`). §Profiles is implemented too,
by the writer the map missed.

**Still not written, and it matters:** `instructions` (top-level), inline `[hooks]`, `[otel]`,
`[history]`, `file_opener`, `project_doc_max_bytes`, `project_root_markers`,
`desktop.custom_file_handlers`, `tui.*`. Of those only `instructions`, `[hooks]` and `[otel]` are
host-relevant; the rest are TUI/CLI (§0.4).

**VERDICT:** `take the contract`
**KIND:** `forgotten vs doc-parity`
**COST:** The shell-environment half is small and self-contained: 2 keys in `buildCodexConfigToml`,
~10 lines, 2 tests (one positive, one boundary — a variable named `*_TOKEN` surviving vs swept), no
dependency. `instructions` and `[hooks]` are each their own row-sized piece and cost **unknown**:
`instructions` collides with our whole `PromptBuilder`/capability-context design (the codex binary
would get one static string where Pi gets per-turn volatile blocks), and `[hooks]` collides with the
four-event Nessy hook vocabulary already shipped.

**CITATION:** `learn.chatgpt.com/docs/config-file/config-advanced.md#shell-environment-policy` — "`ignore_default_excludes`
defaults to `true`, so Codex doesn't automatically remove variable names containing `KEY`, `SECRET`,
or `TOKEN`."

---

## Row 30 — `config-file/config-basic` 🟨

**HEAD-STATUS:** `map STALE: [features] IS now written — multi_agent = true, config-writer.ts:968-969.`
The map's «`[features]` не пишем вовсе (grep -a = 0, позитивный контроль пройден)» is false at HEAD.
The rest of the map's row holds: the six "Common configuration options" keys are still written
(now ten, §0.1), and the precedence chain is still bypassed by construction —
`mkdtempSync(join(tmpdir(), 'nessy-codex-home-'))` at `codex-agent.ts:1204` (the map cited :447;
the line moved, the fact did not).

**OPEN QUESTION, named rather than buried:** we write `multi_agent = true`, and the page's own table
gives `multi_agent` **default `true`, Maturity Stable**, immediately followed by "Omit feature keys to
keep their defaults." So we write a key at its documented default. That is defensible (pinning against
a default flip), but the interaction with a managed `requirements.toml` `features.multi_agent = false`
is **NOT-MEASURED**: I did not determine whether an explicit `config.toml` `true` is rejected,
overridden, or silently honoured against an admin requirement forbidding it. Given `[features]` is
exactly the table `requirements.toml` constrains, this is worth one probe against the shipped binary
before it is called settled.

**VERDICT:** `record the divergence as deliberate`
**KIND:** `forgotten vs doc-parity`
**COST:** Recording costs a paragraph. If the OQ above comes back "requirements wins and errors", the
fix is one conditional in `buildCodexConfigToml` (~8 lines, 2 tests) gated on the requirements reading
that `codex-config-requirements.ts` already produces. §"Windows sandbox mode" and §"TUI keymap" stay
not-ours (own Electron UI; the Windows sandbox keys we DO write go through `windows.ts`, for the
plugin sandbox, not the agent).

**CITATION:** `learn.chatgpt.com/docs/config-file/config-basic.md#configuration-precedence` — "Codex resolves values in this
order (highest precedence first):" (the six-step list; step 3 is the profile files `windows.ts` uses).

---

## Row 31 — `config-file/config-reference` 🟨  ← carries §0

**HEAD-STATUS:** `map WRONG: requirements.toml now appears in FOUR of our own files, and the row says it appears in none.`

The map's «§`requirements.toml` … ни одного нашего файла» is false at HEAD. Files, with the reading
line not merely the mention:
- `packages/shared/src/agent/codex-config-requirements.ts` — 326 lines. `CODEX_CONFIG_REQUIREMENTS_METHOD`
  (:71) = `configRequirements/read`; `readCodexConfigRequirements` (:120-165) parses the result;
  `CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS` (:180) bounds the probe.
- `packages/shared/src/config/managed-in-app-updates.ts` — the one honoured key,
  `[features] in_app_updates`.
- `packages/shared/src/agent/permissions-config.ts:899`, `pi-harness/managed-policy.ts:499` — the
  rule-merge and policy-floor references.

So the page's second half moved from "never touched" to **"read, one of twenty-two fields honoured,
the other twenty-one surfaced by name"** — `readCodexConfigRequirements` pushes every field the server
actually SET onto `unsupported` (:150-160), so an administrator sees what we read and do not apply.
We still never WRITE `requirements.toml`, and should not — it is the admin's file.

The full config.toml inventory is §0 above. Headline: **11 of 53 top-level scalars, 8 of 26 table
prefixes, and every key we emit is in the page.** The map's "15 keys of 94" came from the binary's
`config-schema.json`, not from this page, so it is not comparable — the page is the larger denominator.

`validateConfigAgainstSchema` (config-writer.ts:1075-1141) still validates against the **binary's**
schema, not the page; it enum-checks SandboxMode/AskForApproval/ReasoningEffort/WireApi and requires
`developer_instructions` (:1100) and `description`/`config_file` (:1121) on agent roles. That is the
right seam and should stay — the page is the contract, the schema is the enforcement.

**VERDICT:** `take the contract`
**KIND:** `forgotten vs doc-parity`
**COST:** The inventory itself is done (this file). Turning it into work means picking from §0.4.
Cheapest real item: `sandbox_workspace_write.*` — we set `sandbox_mode` and nothing under it, so the
writable-roots and network sub-keys sit at binary defaults on a sandboxing product. Rough 30-60 lines
in `buildCodexConfigToml` + `resolveRuntimePolicy`, 4-6 tests, depends on deciding whether it
duplicates `[permissions.<n>.filesystem]` (which we DO write) or supersedes it — that is a real
question, not a formality, and it is the reason this is not already done.

**CITATION:** `learn.chatgpt.com/docs/config-file/config-reference.md#requirementstoml` — the section head; the normative
sentence one line above the table is in §`config.toml`'s intro: "Project-scoped config can't override
machine-local provider, auth, host-owned app request metadata, notification, configuration profile
selection, or telemetry routing keys." (Cited from `#configtoml`; the `requirements.toml` half is a
key table with no prose sentence of its own.)

---

## Row 32 — `config-file/environment-variables` 🟨

**HEAD-STATUS:** `map STALE: the CODEX_CA_CERTIFICATE gap is now MEASURED and NAMED IN CODE — commit 79a9968ca (2026-08-27).`

The map reported `CODEX_CA_CERTIFICATE` = 0 files. At HEAD it is **1 file — and that file is a
comment, which is a different verdict, not a smaller one.** `packages/codex-agent-server/src/runtime-manager.ts:139-147`:

> "The binary's own trust store reads exactly two variables — `CODEX_CA_CERTIFICATE` and
> `SSL_CERT_FILE` — and otherwise logs "using system root certificates because no CA override
> environment variable was selected" … So behind TLS interception codex trusts the OS store or
> nothing; handing it our Node-shaped variable changes nothing. That gap is real and needs
> `CODEX_CA_CERTIFICATE`, not this projection."

So the gap has moved from *unknown* to *diagnosed, named, and still open*. That is the strongest
possible case for taking it.

Re-probed at HEAD (positive controls `CODEX_HOME` = 27, `sandbox_mode` = 6):
`RUST_LOG` 0 · `CODEX_ACCESS_TOKEN` 0 · `CODEX_SQLITE_HOME` 0 · `log_dir` 0 · `CODEX_NON_INTERACTIVE` 0 ·
`CODEX_INSTALL_DIR` 0 · `OPENAI_FEDERATION_RULE_ID` 0 · `OPENAI_IDENTITY_TOKEN_FILE` 0 ·
`OPENAI_WORKLOAD_IDENTITY_CONTEXT` 0 (**the last three are page keys the map never listed at all**).
`CODEX_API_KEY` scored 5 files — **false positive**: every hit is the substring inside our own
constant `CODEX_API_KEY_ENV` (config-writer.ts:18); `git grep -E 'CODEX_API_KEY[^_]'` = **0**.
`SSL_CERT_FILE` = 4 files, and the map's reading holds: it rides the generic transport allowlist
(`packages/shared/src/config/managed-env.ts:113`), not this page. Note the child also inherits
`...process.env` wholesale (`runtime-manager.ts:152`), so a host-set `SSL_CERT_FILE` does reach it —
but our bundled `tinkoff-bundle.crt` travels as `NODE_EXTRA_CA_CERTS`, which the binary provably
ignores.

**SEVERITY:** corporate TLS interception is precisely this deployment's environment. Today a codex
session behind the corporate MITM has exactly one CA path (`SSL_CERT_FILE`, if the host happens to set
it) and no way to be handed the bundle the app already ships.

**VERDICT:** `take the contract`
**KIND:** `forgotten vs doc-parity`
**COST:** Small and well-scoped: set `CODEX_CA_CERTIFICATE` in the spawn env at
`runtime-manager.ts:152-155`, pointed at the same bundle `NODE_EXTRA_CA_CERTS` already names. ~10-15
lines + 2 tests (present / absent). Depends on nothing; the measurement that justifies it is already
in the file. `RUST_LOG` + `log_dir` are a second, cheaper item (support diagnostics) worth ~10 lines.

**CITATION:** `learn.chatgpt.com/docs/config-file/environment-variables.md#authentication-and-network` — "`CODEX_CA_CERTIFICATE`
… Points to a PEM CA bundle for environments with corporate TLS interception or private root
certificates. Takes precedence over `SSL_CERT_FILE`."

---

## Row 33 — `config-file/config-sample` 🟨

**HEAD-STATUS:** `map STALE: three of the fourteen "sections we don't have" are now written — [features], [auto_review], and profiles (via windows.ts).`

The map's missing list was `[history]`, `[otel]`, `notify`, `[tui]`, `file_opener`,
`profile`/`profiles`, `[features]`, `model_instructions_file`, `compact_prompt`,
`experimental_compact_prompt_file`, `oss_provider`, `service_tier`, `review_model`, `personality`.
At HEAD: `[features]` written (:968), `[auto_review]` written (:976), `profiles` written by
`windows.ts:195/250`. The other eleven re-probed and still 0 (`[history]` `[otel]` `[tui]`
`file_opener` `model_instructions_file` `compact_prompt` `oss_provider` `service_tier` `review_model`
`personality` all = 0 files; positive control `sandbox_mode` = 6).

The map's one manual check still holds and is the good part of this row:
`model_auto_compact_token_limit` is a hand-set constant in the sample and a **derived** value for us
(`autoCompactTokenLimit`, config-writer.ts:873, called at :930), with the rationale at :936-938
recording a measurement ("F5 watched five turns reach 91.5% of the window"). That is behaviour derived
from practice, correctly diverging from a sample.

**VERDICT:** `record the divergence as deliberate`
**KIND:** `forgotten vs doc-parity`
**COST:** ~0 as its own row. This page is `config-reference`'s key set rendered as one annotated
sample; its 534 `#` lines are TOML comments, not headings, and its anchor file carries **no content
anchors at all**. Every actionable item it could raise is already row 31's. Recommend closing this row
by reference to 31 rather than funding it separately — funding it twice is how the same key gets
triaged twice.

**CITATION:** `[doc:codex]` `config-file/config-sample.md` — no section anchor exists on this page
(anchors file contains only chrome ids: `header`, `drawer`, `mainContent`, `s0`, …). The page's own
framing sentence sits before any heading: "Use this example configuration as a starting point. It
includes most keys Codex reads from `config.toml`, along with default behaviors, recommended values
where helpful, and short notes." Nearest normative section elsewhere in the corpus:
`learn.chatgpt.com/docs/config-file/config-reference.md#configtoml`.

---

## Row 37 — `customization/overview` 🟨

**HEAD-STATUS:** `map WRONG: .agents/skills IS read, as BOTH layers of the page's own table, and has been since 2026-07-05.`

The map says «`.agents/skills` как repo-слой из таблицы страницы у нас не читается (свой плагинный
путь)». Measured, with the reading lines and not the mentions:
- `packages/shared/src/skills/storage.ts:34` — `GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills')`,
  read at :465 `loadSkillsFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global')`.
- `:37` — `PROJECT_AGENT_SKILLS_DIR = '.agents/skills'`, read at :475-479
  `loadSkillsFromDir(join(projectRoot, PROJECT_AGENT_SKILLS_DIR), 'project')`, gated on
  `projectTrusted` (W6, fail-closed) — which matches the page's own project-trust rule.
- Further real readers: `native-sources.ts:1335`, `:1450`, `:1687`; `core/pre-tool-use.ts:367`, `:377`
  (`existsSync(join(…, PROJECT_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))`).
`git log -S` dates the constant to `845cf0a41`, **2026-07-05** — seven weeks before the map. This is a
map error, not drift. Both rows of the page's `| Skills | ~/.agents/skills | .agents/skills in repo |`
table are satisfied host-side.
*(NOT-MEASURED: whether the bundled codex binary ALSO reads `.agents/skills` from cwd on its own. Our
projection reaches it via `CODEX_DEFAULT_SKILLS_DIR`, `format-adapters/codex.ts:138`, which is enough
for the layer to work but is not the same claim.)*

**Live status re-checked at HEAD, as dispatched:** `docs/testing/cdp-live-checklist.md` row `CDX-ROLES` (the map
cited :42 — line moved, verdict did not):
`| CDX-ROLES | cdx-roles.ts | Nessy agent dispatches as a codex role | 2026-08-21 | BLOCKED | probe-role agent file gone from the operator agents dir |`
**Still BLOCKED, seven days.** The narrative (`cdp-runs/2026-08-21-1.31.0-close-out.md:83`) groups it
with CRU-5/CRU-6 as a rig-fixture loss ("the probe-role agent file is gone from the operator's …"),
not a product failure — so this is an unproven layer, not a broken one. The distinction matters: four
of the page's five layers are built, and the fifth (subagents, `[agents.<role>]`, config-writer.ts:1047,
32 tests across `config-writer-agent-roles.test.ts` (19) and `config-writer-execpolicy-rules.test.ts` (13))
is built and unit-tested but has had **no live confirmation for a week**.

**VERDICT:** `take the contract`
**KIND:** `bug`
**COST:** Restoring CDX-ROLES is rig work, not product work: re-create the probe-role agent file in
the operator agents dir and re-run `scripts/cdp/cases/cdx-roles.ts`. Rough: under an hour if the
fixture is the only thing missing; **unknown** if the run then fails for a second reason. Nothing else
on this page needs building — the map's fifth-layer claim (Memories) is row 38's, and the AGENTS.md /
Skills / MCP layers are all confirmed at HEAD.

**CITATION:** `learn.chatgpt.com/docs/customization/overview.md#skills` — "Skills can be global (in your user directory, for
you as a developer) or repo-specific (checked into `.agents/skills`, for your team)."

---

## Row 38 — `customization/memories` 🟨

**HEAD-STATUS:** `map still correct` — every absence re-probed and holds.
`memories` = 6 files, and **not one is a codex file**: `agent/memory/memory-store.ts` (ours),
`backend/claude/event-adapter.ts` + its test (Claude's memory tool),
`session-tools-core/src/runtime/credential-deny-roots.ts`, `capabilities/native-sources.ts`,
`scripts/codex-doc-pages.tsv` (the page index itself). `generate_memories` = 0, `use_memories` = 0,
`[memories]` = 0 (positive controls `sandbox_mode` = 6, `CODEX_HOME` = 27). `[features]` is now
written (§0.1) but carries only `multi_agent`, never `memories` — so the page's enable switch is still
absent, exactly as the map says, for a newly different reason.
`~/.codex/memories/` remains unreachable by construction: `codex-agent.ts:1204` mkdtemps CODEX_HOME
per session and teardown removes it.

**SEVERITY (one line):** the page states codex "redacts secrets from generated memory fields" and then
still says "Don't store secrets in memories." Our substitute — the `remember` session tool writing
MEMORY.md (`packages/session-tools-core/src/tool-defs.ts:180-181`, `handlers/remember.ts`) — has **no
redaction step**. That is not a reason to build codex memories; it is a gap in the thing we built
instead, and it belongs on somebody's row.

**VERDICT:** `record the divergence as deliberate`
**KIND:** `forgotten vs doc-parity`
**COST:** Recording is a paragraph. *Not* building it is the right call and the reason is
structural, so write the reason down: memories are per-CODEX_HOME generated state, our CODEX_HOME is a
per-session tempdir, and making them work would mean giving codex a durable home — which would undo
the session-isolation decision recorded in
`docs/superpowers/plans/2026-08-14-session-runtime-switching.md:87`. The page's subject ("carry useful
context from earlier work into future work") is already closed by `remember` → MEMORY.md with
`session|project|user` scope, which rides `executionMode:'registry'` and is NOT in
`SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, so it reaches the codex build of session-mcp-server. The
redaction gap above is the only real cost item, ~30 lines + 2 tests in `handlers/remember.ts`.

**CITATION:** `learn.chatgpt.com/docs/customization/memories.md#local-memory-storage` — "The main memory files live under
`~/.codex/memories/` and include summaries, durable entries, recent inputs, and supporting evidence
from prior chats."

---

## NOT-MEASURED (stated rather than padded)

1. **Row 30** — whether an explicit `config.toml` `[features] multi_agent = true` is rejected,
   overridden, or silently honoured against a managed `requirements.toml`
   `features.multi_agent = false`. Needs a probe against the shipped binary; I did not run one.
2. **Row 37** — whether the bundled codex binary itself reads `.agents/skills` from cwd, independently
   of our `CODEX_DEFAULT_SKILLS_DIR` projection.
3. **Row 26** — I did not attempt to determine whether `review/start` actually works on the shipped
   binary (0.148.0); I measured only that we never call it and that the method + `ReviewStartParams` +
   `ReviewDelivery` are in the generated bindings.
4. **§0.2** — whether `docs/architecture/runtime-control-boundary.md:149`'s "`profiles` … Never
   evaluated" is in-scope-correct (the table may be scoped to the codex *runtime*, excluding the
   pi-harness Windows sandbox). The table does not say, so I report it as ambiguous rather than wrong.

---

# Lane C — codex coverage-map re-triage at HEAD

Repo HEAD at audit time: **`b1824c4b4334256bc678cf6e932bac81e9d1b222`** (the brief's `f58f66a36` had already
moved; six lanes commit concurrently). Branch `feat/TCODE-000`.

Rows: 40, 43, 53, 54, 55, 59, 62, 64, 65, 66, 67.

## Method notes that bound every claim below

- All probes via `probe.sh` (`git grep -a -I -F -l` over `packages/ apps/ scripts/`, excluding
  `node_modules`, `.references`, `release`, `apps/electron/resources`, `codex-protocol/{schema,generated}`,
  `dist`). Positive controls on the same runs: `sandbox_mode` files=6, `CODEX_HOME` files=27,
  `.agents` files=96, `SKILL.md` files=150. Negative controls that stayed zero: `network_proxy`,
  `computer_use`, `managed_config.toml`, `com.openai.codex`.
- **A hit count is a MENTION count.** Every "built" claim below names the line that WRITES or READS
  the key, and I threw out four hits that were only mentions:
  `enabled_tools`/`disabled_tools` in `config-writer.ts:642-643` (a comment saying codex has no per-role
  tool allowlist); `approval_mode` in `codex-agent-server/src/approval-bridge.ts:226` (a comment);
  `allowedPluginKeys` in `server-core/src/bootstrap/storage-runtime.ts:903` (a comment explaining why it
  is deliberately NOT read there); `browser_use` (a test fixture, `codex-config-requirements.test.ts:228`).
- Citations quote the local `.md` verbatim; anchors are the extracted rendered-page `id="…"` values, not
  slug-derived.

---

## Row 40 — `cyber-safety/recommended-configuration` (map 🟨)

**HEAD-STATUS:** `map STALE: its item (2) and half of item (3) are now BUILT — 7736e32a9 + 384e2fb38
(approvals_reviewer/auto_review), 7bc247a87 (prefix_rule). Only the network half of item (3) survives.`
**Tag:** `[doc:codex]`

Re-measured, the page's config block now stands at **four of five clauses taken**:

| page clause | HEAD | write site |
| --- | --- | --- |
| `[permissions.<name>]` + `description` + `extends` + `.filesystem` deny | BUILT | `config-writer.ts:1003-1011` (`lines.push('[permissions.…]', 'description = …', 'extends = …', '[permissions.….filesystem]', …)`) |
| `approvals_reviewer = "auto_review"` | **BUILT since the map** | `config-writer.ts:953` — emitted top-level, gated `emitAutoReview = opts.approvalsReviewer === 'auto_review' && approvalPolicy !== 'never'` (`:919`), which is exactly the page's clauses 1+2 |
| `[auto_review].policy` | **BUILT** (page does not require it; we add it) | `config-writer.ts:976` |
| `prefix_rule(pattern=[…], decision=…)` under `~/.codex/rules/` | **BUILT since the map** | `buildCodexExecpolicyRules` (`config-writer.ts:482-502`) written to disk at `:1228-1229` (`mkdirSync(join(codexHome, CODEX_RULES_DIR))` + `writeFileSync(…, rulesText)`) |
| `[features] network_proxy = true` + `[permissions.*.network]` domains allowlist | **STILL ABSENT** | `network_proxy` files=0; `network.domains` 0; `allow_local_binding` 0; `glob_scan_max_depth` 0; `git grep 'network' config-writer.ts` = **no hits at all** |

The residue is one coherent thing, not four: **we emit no network stanza whatsoever.** We never set
`network.enabled = true` either, so we are not in the page's dangerous state — we are in the state where
the sandbox's own default network posture applies unexamined and no domain allowlist exists to enforce.
That is a gap to record rather than a live hole.

- **VERDICT:** `take the contract` (for `[features] network_proxy` + a network stanza); the other four
  clauses are closed and the row should drop to ✅ on everything but network.
- **KIND:** `forgotten vs doc-parity`
- **COST:** `packages/codex-responses-adapter/src/config-writer.ts` — a `network_proxy` bool in the
  existing `[features]` table (~2 lines) plus a `[permissions.<profile>.network]` + `.network.domains`
  emitter (~25 lines) fed by a new setting; a schema drift-guard mirroring the `multi_agent` one at
  `:1107-1113` (~8 lines); tests in `config-writer.test.ts` (~2 cases). Depends on a product decision
  about where the domain allowlist comes from — we have no per-session network allowlist model today, so
  the setting does not exist yet. Real dependency, not a line count.
- **CITATION:** `learn.chatgpt.com/docs/cyber-safety/recommended-configuration.md#define-and-enforce-approved-boundaries` —
  "The `network_proxy` feature enforces the approved domain. Without it,
  `network.enabled = true` permits direct network access and the lab allowlist
  does not restrict destinations."

---

## Row 43 — `enterprise/admin-setup` (map 🟨)

**HEAD-STATUS:** `map still correct` on its boundary split; one sub-claim of Step 3 is now partly reachable
via row 54's probe.
**Tag:** `[doc:codex]`

Re-probed: `scim` 0, `seatType` 0, `workspaceRole` 0, `rbac` 1 (a doc-comment, not a gate). The map's
"only Step 3 and Step 4 are ours" split holds.

- **Step 3** (`requirements.toml` for local runtime): as of P2.7 we now *read* a composed requirements
  document through `configRequirements/read` — see row 54 — but of the page's own Step-3 examples we act on
  **none**: `allowed_permission_profiles` files=0, `default_permissions` written only as our own
  `nessy_runtime` profile name (`config-writer.ts:956`), never constrained by a requirement;
  `computer_use`/`in_app_browser`/`browser_use` as *enforced* keys files=0 (the one `browser_use` hit is a
  test fixture). So Step 3 moved from "no channel" to "channel open, one key consumed".
- **Step 4** (repository configuration in `.codex` or `.agents`): **half taken, deliberately.** `.agents`
  is real and repo-scoped at HEAD — `skills/storage.ts:34` (`~/.agents/skills`),
  `slash-commands/custom-commands.ts:67` (`.agents/commands`), `agent/memory/memory-store.ts:41`
  (`.agents/rules`), `capabilities/native-sources.ts:1581` (`<workspaceRoot>/.agents/rules`),
  `projects/project-capability-watcher.ts:42` (`WATCHED_PROJECT_DIRS = ['.nessy-agent', '.agents']`).
  Project-scoped `.codex` is read by nothing: `git grep "'.codex'"` over `shared/src`, `server-core/src`,
  `codex-responses-adapter/src` = 0 production hits, matching the deliberate refusal pinned in
  `plugins/__tests__/project-config.test.ts:46`.

- **VERDICT:** `record the divergence as deliberate` for `.codex` project config and for Steps 1/2/5/7/8;
  `take the contract` for the Step-3 feature-key constraints (they are the same channel row 54 opened).
- **KIND:** `forgotten vs doc-parity` (Step 3 keys) / `record the divergence as deliberate` (Step 4 `.codex`)
- **COST:** unknown for the Step-3 keys until row 54's honoured-set is widened — the marginal cost of each
  additional key there is small (a branch in `readCodexConfigRequirements` plus its consumer), but every
  key needs a real host consumer, and `computer_use`/`browser_use`/`in_app_browser` have none: this app
  ships no computer-use or in-app-browser surface, so the honest cost is "0 lines, because there is nothing
  to gate". Writing the divergence down is the whole work.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/admin-setup.md#step-4-standardize-repository-configuration` —
  "Use repository-scoped configuration to share project defaults, rules, and
  skills without duplicating setup for every user."

---

## Row 53 — `enterprise/manage-app-updates` (map 🟥 — **WRONG at HEAD**)

**HEAD-STATUS:** `map WRONG: the row says "no managed gate" and "поля тоже нет"; at HEAD all three of the
page's normative clauses are BUILT — 39d9d7c88 + 3a6cef117, plus P2.137/P2.138 follow-ups.`
**Tag:** `[doc:codex]`

The owner's question was scope, so here is the clause-by-clause delta. **All three are taken:**

1. **`[features] in_app_updates = false` from `requirements.toml` disables the host's own updater** —
   BUILT. Read at `codex-config-requirements.ts:readCodexConfigRequirements` (`features[CODEX_IN_APP_UPDATES_FEATURE_KEY] === false → inAppUpdatesDisabled = true`), written into the tier at
   `codex-agent.ts:1372` (`recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)`),
   consumed by `areInAppUpdatesManagedDisabled()` at `auto-update.ts:117` inside
   `inAppUpdatesDisabledByPolicy()`, which is called at **six** entry points (`:134, :217, :286, :423,
   :493, :564`) and additionally clears `autoUpdater.autoDownload` and `autoUpdater.autoInstallOnAppQuit`
   so electron-updater's two caller-free paths cannot run.
2. **The "Managed" indicator in Settings > General** — BUILT. `UpdateInfo.managedDisabled` (`dto.ts:1230`)
   is set at `auto-update.ts:140`, read by `isUpdatesManagedOff` (`AppSettingsPage.tsx:56-58`) and
   rendered at `AppSettingsPage.tsx:491-493` (`t("settings.about.updatesManaged")` →
   `en.json:1545` "Your organization's policy disables in-app updates, so this app does not check for or
   install them."). A live page flips without navigation via
   `subscribeManagedInAppUpdatesChange` → `broadcastUpdateInfo()` (`auto-update.ts:177-179`).
3. **"Check for Updates can remain visible"** — BUILT, and cited in the code. `checkForUpdates`
   (`auto-update.ts:414-424`) refuses at the ACTION and the comment quotes `manage-app-updates.md:84-86`
   verbatim; the macOS menu template (`menu.ts:73-75`) is untouched. (Nuance the page permits: the
   *Settings* "Check now" button IS disabled, `AppSettingsPage.tsx:475` — the page says the menu option
   *can* remain visible, not that it must, so this is inside the contract.)

**Two residues worth a row, both already named in the source rather than hidden:**

- **`checkForUpdatesOnLaunch()` still runs UNGATED at first boot of a codex-only fleet.** The codex tier is
  module-scope and unpersisted, so it can only be armed after the first codex runtime starts — stated
  verbatim at `codex-agent.ts:1364-1368`. The page's own troubleshooting anticipates this ("the app might
  still use a cached policy … Don't rely on the update restriction until **Managed** appears"), so it is a
  known-shape gap, but the host-side fix (persist the last-known requirement, read before the launch check)
  is not written.
- **The page's second half is untouched.** "Deploy approved app versions", "Turn in-app updates back on"
  and "Understand security and support responsibilities" describe an MDM redistribution process; we have
  no MDM channel (`com.openai.codex` files=0).

- **VERDICT:** `take the contract` — and the row's glyph is wrong: 🟥 → ✅ for the three normative clauses,
  with ONE new open item (the unpersisted-tier launch-check hole).
- **KIND:** `bug` for the row's own claim (the map asserts an absence that HEAD refutes); the residue is
  `forgotten vs doc-parity`.
- **COST (residue only):** persist the last-known codex requirement — one small JSON alongside the existing
  managed-policy bootstrap in `packages/server-core/src/bootstrap/managed-policy-resolution.ts` (~40 lines)
  plus a read before `checkForUpdatesOnLaunch()` in `apps/electron/src/main/index.ts:1352` (~5 lines), and
  a staleness rule (how long a cached requirement is trusted) that is a product decision, not a line count.
  Tests: `auto-update-managed-gate.isolated.ts` already has the rig.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/manage-app-updates.md#verify-the-managed-setting` —
  "The **Check for Updates** menu option can remain visible even when the policy
  blocks in-app updates."

---

## Row 54 — `enterprise/managed-configuration` (map 🟨 — highest-value row)

**HEAD-STATUS:** `map STALE: "configRequirements/read never sent" is false at HEAD — codex-agent.ts:1329
sends it after initialize. The map's larger claim (the Codex side is not taken) is still ~95% true, and
this row is where the exact fraction lives.`
**Tag:** `[doc:codex]+[doc:claude]` — the mechanisms this page maps onto (`managed-policy.ts`,
`managed-mcp-entries.ts`, `managed-marketplace-entries.ts`) were built to Claude's
`settings-reference.md`, `managed-mcp.md`, `plugin-marketplaces.md`, and their headers still cite those.

### What is now taken — measured at the read/write sites, not the mentions

**The delivery channel is open.** `probeCodexConfigRequirements(client, …)` is called at
`codex-agent.ts:1329`, after `client.notify('initialized')` (`:1321`) and before `thread/start` (`:1381`) —
which is exactly where the page's "when resolving configuration" sequence puts it. It is bounded
(`CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS = 5_000`, measured against the shipped binary's 1-5 ms answer, so it
cannot fire on a merely-slow server), it never throws, and it distinguishes a definitive refusal
(`-32600/-32601/-32602`) from a transient failure. Only `'read'`/`'none'` may write the tier
(`codex-agent.ts:1370-1372`), so a failed probe cannot clear a deployed requirement.

**Architecturally this is the RIGHT shape and worth saying out loud:** the page's four precedence layers
(`/etc/codex/requirements.toml`, cloud bundle, legacy `managed_config.toml` reinterpretation, MDM
`com.openai.codex:requirements_toml_base64`) are composed **by the app-server**, and we ask it for the
result rather than re-reading four sources ourselves. Our own probes confirm we read none of them directly
(`requirements.toml` appears in 5 files, all of them doc-comments or the doc-page TSV;
`managed_config.toml` 0; `com.openai.codex` 0) — that is correct delegation, not a gap.

### The exact delta — 1 field of 22

`ConfigRequirements` (`packages/codex-protocol/generated/v2/ConfigRequirements.ts`) has **22 fields.**

**HONOURED — 1:**
- `featureRequirements.in_app_updates` → `disableInAppUpdates` (row 53).

**READ AND REPORTED, NOT APPLIED — 21.** They are not silently dropped:
`formatCodexConfigRequirementsDiagnostics` emits `[managed] codex requirements read but NOT applied: …`
naming every field the server actually SET. The 21 are:
`allowedApprovalPolicies`, `allowedSandboxModes`, `allowedWindowsSandboxImplementations`,
`allowedPermissionProfiles`, `defaultPermissions`, `allowedWebSearchModes`, `allowManagedHooksOnly`,
`allowAppshots`, `allowRemoteControl`, `computerUse`, `browserUse`, `enforceResidency`, `autoReview`,
`models`, `sqliteHome`, `logDir`, `modelCatalogJson`, `checkForUpdateOnStartup`, `allowLoginShell`,
`feedback`, `windowsSandboxPrivateDesktop` — plus every non-`in_app_updates` key inside
`featureRequirements`.

**The sharpest five, because we have a working analogue and still do not bind it** (the map's own
`ManagedPiPolicyV1` ↔ `requirements.toml` mapping, re-verified at HEAD as REAL gates, not declarations):

| requirements field | our analogue | the analogue's real gate |
| --- | --- | --- |
| `allowManagedHooksOnly` | `ManagedPiPolicyV1.allowManagedHooksOnly` | `storage-runtime.ts:906-908` (`isManagedHooksOnly(...)` + `resolveManagedPluginActivation(...) === 'force-enabled'`) |
| `featureRequirements.plugins` / plugin availability | `allowedPluginKeys`/`deniedPluginKeys`/`enabledPlugins` | `isManagedPluginAllowed` (`managed-policy.ts:1871-1875`), called at `storage-runtime.ts:891` and `:1105` |
| `allowedSandboxModes` / `defaultPermissions` | `managed-policy.ts` `sandbox`/`defaultMode` | present |
| `allowedPermissionProfiles` | — | none (`allowed_permission_profiles` files=0) |
| `autoReview` | our own `approvals_reviewer`/`[auto_review].policy` writer | `config-writer.ts:953, 976` — we WRITE the setting, and ignore an administrator's requirement about it |

That last row is the one I would put in front of the owner: **we now configure auto-review from our own
settings and simultaneously read-and-discard the requirement that constrains it.** Nothing enforces that
our written value is inside the administrator's allowed set.

### The page's second half is entirely untaken

`## Managed defaults (managed_config.toml)` — locations, macOS MDM preferences, the MDM setup workflow, the
recommended guardrails — has **no channel at all**: `configRequirements/read` returns requirements, not
defaults, and `managed_config.toml` files=0. This is not a "we chose otherwise": there is no mechanism.

### One correctness consequence, stated plainly

The page says a conflicting value makes the client "fall back to a compatible value and notify the user."
Our diagnostics are routed to `this.debug(message)` → `BaseAgent.debug` → `this.onDebug?.(message)`
(`base-agent.ts:2252-2254`) — a debug sink, **not user-visible UI**. So when the bundled app-server silently
degrades a session's approval policy or sandbox mode to satisfy `/etc/codex/requirements.toml`, the user
sees nothing. That is the same gap the map recorded, unchanged, and it is now sharper because we *do* have
the text and *do* have a place it could go.

- **VERDICT:** `take the contract`
- **KIND:** `forgotten vs doc-parity`
- **COST:** Widening the honoured set is cheap per field and expensive in consumers.
  Machinery: `readCodexConfigRequirements` already enumerates every set field, so binding one more is
  ~10 lines there plus its consumer. The five above differ sharply: `autoReview` is the cheapest and
  highest-value (clamp `opts.approvalsReviewer` against the requirement before `config-writer.ts:919`,
  ~15 lines + 2 tests); `allowedSandboxModes`/`defaultPermissions` need a clamp in the same writer
  (~30 lines) and a decision about what a user sees when their chosen mode is refused; `allowManagedHooksOnly`
  and plugin availability need the codex requirement folded into the composed `ManagedPiPolicyV1` in
  `server-core/src/bootstrap/managed-policy-resolution.ts`, which is a real cross-package change (unknown,
  but not small — the policy is composed once at bootstrap and the codex answer arrives mid-session).
  Surfacing the degradation notice to the user is a separate, small UI change (~20 lines) once a channel
  is chosen. `managed_config.toml` is **unknown and probably not ours** — no method exists to read it.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/managed-configuration.md#admin-enforced-requirements-requirementstoml` —
  "When resolving configuration (for example from `config.toml`, [profile files](…), or CLI config
  overrides), if a value conflicts with an enforced rule, the local client falls back to a compatible
  value and notifies the user."

---

## Row 55 — `enterprise/apps-and-connectors` (map 🟨)

**HEAD-STATUS:** `map still correct`
**Tag:** `[doc:codex]+[doc:claude]` — our plugin gates were built to Claude's `settings-reference.md`
(`managed-policy.ts:1878` cites `settings-reference.md#enabledplugins` and `#what-runs-under-allowmanagedhooksonly`).

Re-verified the gates are USES, not declarations: `isManagedPluginAllowed` (`managed-policy.ts:1871-1875`,
reading `deniedPluginKeys`, `enabledPlugins`, `allowedPluginKeys`) is called in production at
`storage-runtime.ts:891` and `:1105`. `strictKnownMarketplaces` files=14. So the page's **Availability**
layer is real for us.

What is measurably NOT reconciled is the page's *six-layer separation*. We have no distinct notion of
**App access**, **Actions and permissions**, or **Service authorization** — those are `chatgpt.com/admin/*`
workspace surfaces (correctly `not our surface`), but the page's load-bearing consequence is a claim about
*our* layer: installing a plugin must not grant its connector. Our capability model
(`packages/shared/src/capabilities/resolver.ts`, `server-core/src/handlers/rpc/capabilities.ts`) does
separate install from capability consent, but **nobody has ever checked our separation against this table** —
citations 0, no plan references the page.

- **VERDICT:** `record the divergence as deliberate` for the admin-console layers (Availability admin UI,
  the `public-plugins-security-review.csv` export, App access, Actions, Service authorization — all
  workspace surfaces we do not host); `take the contract` for the one sentence that pins the runtime
  layer to us.
- **KIND:** `never looked at`
- **COST:** ~0 code. This is an audit task: walk the six layers against
  `packages/shared/src/capabilities/resolver.ts` + `server-core/src/handlers/rpc/capabilities.ts` and write
  the verdict down (half a day, no lines). If the audit finds our install path grants a connector
  implicitly, that becomes a security row — I did not measure that here.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/apps-and-connectors.md#understand-the-capability-chain` —
  "Use these layers as a two-step rollout: first make the right plugins available,
  then configure the capabilities and permissions each workflow needs."

---

## Row 59 — `enterprise/skills` (map 🟨)

**HEAD-STATUS:** `map still correct`, with one refinement it did not make.
**Tag:** `[doc:codex]`

Re-probed: `SKILL.md` files=150, `skillId` 23, `SkillDefinition` **0** (the map's probe string is dead as
written — the type does not exist under that name; the live type is in `packages/shared/src/skills/types.ts`).
Two of three distribution models are ours, as the map said.

**The refinement the map missed, and it is a real divergence:** the page's "Local filesystem skill" spans
"a repository, user, administrator, or bundled system location" — **four** origins. Our
`SkillSource.scope` is `'user/global' | 'workspace' | 'project'` (`skills/types.ts:117`) — three, and
*administrator* is not among them. Bundled/system exists but through a different door
(`skills/seed.ts:42,98`, `getBundledAssetsDir('skills')`, seeded into `<CONFIG_DIR>/skills`), and a managed
skills root exists only as prose in `capabilities/types.ts:169`. So an administrator-distributed skill
location is not a scope we model.

- **VERDICT:** `take the contract` for the administrator origin; `not our surface` for the ChatGPT
  workspace Skill model (a chatgpt.com feature, no local runtime).
- **KIND:** `forgotten vs doc-parity`
- **COST:** unknown — adding a fourth `scope` value touches `skills/types.ts`, `skills/storage.ts`
  (`loadSkillsFromDir` call sites), the precedence order, and every UI that renders a scope badge. The
  cheaper reading is that our managed-skills root already covers the administrator case and only the
  *vocabulary* diverges, in which case the cost is a recorded divergence and 0 lines. Deciding which of
  those two it is needs the owner, not a probe.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/skills.md#skill-distribution-and-administration` —
  "Plugin installation doesn't grant access to a connector, MCP server, or
  connected service."

---

## Row 62 — `enterprise/workspace-model-availability` (map 🟨) — **SEVERITY: a shipped default retires in 3 days**

**HEAD-STATUS:** `map WRONG on its own probe: it recorded "gpt-5.4 в исходниках 0 файлов" and concluded
"ретайрмент 31.08.2026 нас не ломает". At HEAD gpt-5.4 files=6, and one of them is a shipped default on
exactly the sign-in boundary the retirement covers.`
**Tag:** `[doc:codex]`

**Top line: `PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = ['gpt-5.4-mini']` (`llm-connections.ts:870`) is a
ONE-ELEMENT list naming a model that retires 2026-08-31 — three days from this audit.** The
`'openai-codex'` provider is the ChatGPT Plus/Pro OAuth / ChatGPT-JWT path, documented as such at
`llm-connections.ts:289` — precisely the "signed in with ChatGPT" boundary the page's retirement applies to,
and precisely the one the page's carve-out ("The OpenAI API and Codex authenticated with your own API key
aren't affected") does NOT protect.

The failure mode is silent, and the file states it two dozen lines up (`llm-connections.ts:838-846`): "a
candidate that does not resolve is skipped, so an invented id silently degrades the pick rather than
failing loudly". With a single candidate, the codex-subscription mini pick degrades to **nothing** — the
same shape that already cost `github-copilot` and `amazon-bedrock` their mini picks and billed background
tasks at the top-tier rate. `openai` (`:869`) also carries `gpt-5.4-mini`, but behind `gpt-5-mini`, so it
degrades gracefully.

`gpt-5.6` files=0 — neither replacement (`gpt-5.6-terra`, `gpt-5.6-luna`) exists anywhere in the tree.

Everything else in the row re-measures as the map said: `isDeniedMiniModelId` (`llm-connections.ts:294-299`)
is a real predicate encoding the ChatGPT-account refusal; `PI_PREFERRED_DEFAULTS['openai-codex']`
(`:820`) is gpt-5.5/5.2/5.1/5/o4-mini/o3/gpt-4o. Not measured: `features.fast_mode` (`fast_mode` files=0).

- **VERDICT:** `take the contract`
- **KIND:** `bug` (a shipped default with a dated expiry, and the map's probe that would have caught it
  read zero)
- **COST:** `packages/shared/src/config/llm-connections.ts:869-870` — replace `gpt-5.4-mini` with
  `gpt-5.6-luna` and give `'openai-codex'` at least one fallback; consider `gpt-5.6-terra` for `:819-820`.
  ~4 lines. Depends on verifying both ids resolve in the shipped Pi catalog — the file's own rule is that
  every id must be verified present, and I did **NOT** verify that (see NOT-MEASURED below). Tests:
  `packages/shared/tests/models.test.ts`, `packages/pi-agent-server/src/pick-mini-model.test.ts` already
  exercise this table.
- **CITATION:** `learn.chatgpt.com/docs/enterprise/workspace-model-availability.md#prepare-for-the-gpt-54-retirement` —
  "On August 31, 2026, GPT-5.4 and GPT-5.4 mini retire from Codex for users signed
  in with ChatGPT."

---

## Row 64 — `environments/modes` (map 🟨)

**HEAD-STATUS:** `map still correct`
**Tag:** `[doc:codex]`

Re-probed the picker claim, which is the row's whole content: `EnvironmentPicker` 0, `environmentMode` 0,
`worktreeMode` 0, `cloudEnvironment` 0, `startInWorktree` 0, `newChatWorktree` 0; and
`git grep -il worktree` over `renderer/components/composer` and `renderer/components/app-shell` returns
**nothing**. Positive control on the same run: `EnterWorktree` files=31. So the picker is still absent and
the entry is still agent-initiated — `EnterWorktree`/`ExitWorktree` are registry tools with
`safeMode: 'block'` (`session-tools-core/src/tool-defs.ts:1169-1170`), i.e. they route through approval.
`bgIsolation` is a real read (`agent/core/pre-tool-use.ts`, `agent/bash-validator.ts`, `config/storage.ts`),
default `'none'` (`worktree-settings.ts:139`).

Two of three modes exist; **Cloud** does not and is not ours (no Codex cloud on this product — gateway is
Nestor).

- **VERDICT:** `take the contract` for the environment picker; `not our surface` for Cloud.
- **KIND:** `forgotten vs doc-parity`
- **COST:** a composer-level environment selector is genuinely new UI: a control in the composer, a
  session-creation parameter threaded through `SessionManager`, and a pre-turn worktree lease acquisition
  that today only happens mid-turn via a tool. Unknown, and larger than it looks — the worktree machinery
  is all there (`worktree-lease-service.ts`), but nothing calls it before a session's first turn.
- **CITATION:** `[doc:codex]` `environments/modes.md` — the page has **no normative section anchor**: it is
  a single `#` heading and the rendered page publishes only `mainContent` (verified against
  `anchors/environments_modes.txt`). Citing the page without an anchor, per the brief's fallback:
  "When starting a Codex chat, choose where it runs:" … "**Worktree**: isolate changes in a Git worktree."

---

## Row 65 — `environments/local-environment` (map 🟥 — **WRONG at HEAD on its first section**)

**HEAD-STATUS:** `map WRONG: the row asserts "setupScript 0, setup script 0, postCreateCommand 0" and
"Нет ничего из этого". Setup scripts are BUILT — commit 721b7374e, "feat(worktrees): setup scripts run on
creation with consent". setupScript files=11, postCreateCommand 2.`
**Tag:** `[doc:codex]`

**Section 1 — Setup scripts: BUILT, and it is a real execution, not a declaration.**
`worktreeSetupCommand()` (`server-core/src/pi-harness/worktree-setup-plan.ts:55-70`) builds the argv and is
called in production at `worktree-lease-service.ts:468` — `await port.run(worktreeSetupCommand({
worktreePath: lease.path, script }))` — on worktree creation, which is exactly the page's trigger. The
setting is `worktree.setupScript` (`config/worktree-settings.ts:106,118,181-189`), consent-gated
(`shared/src/sessions/worktree-setup-consent.ts`, UI pin
`renderer/components/app-shell/__tests__/WorktreeSetupPermission.test.tsx`), `cwd` is the new worktree, and
the budget is 600 s.

**Two sub-clauses of section 1 still open:** the page stores this in a repo-checked-in `.codex` folder
("You can check the generated file into your project's Git repository to share with others") — ours is a
config-tier setting, and `.codex` project config is read by nothing (deliberate, `project-config.test.ts:46`);
and the page's **per-platform** scripts ("define setup scripts for macOS, Windows, or Linux to override the
default") have no analogue — `worktree-settings.ts` carries no platform branch at all (`git grep -i
'darwin\|win32\|linux'` over that file = 0). `worktreeSetupCommand` picks the *interpreter* per platform,
which is a different thing.

**Section 2 — Actions: still absent.** `projectAction` 0, `projectActions` 0. No top-bar action list.
**Section 3 — Integrated terminal and built-in Git tools: still absent.** `integrated terminal` 0,
`IntegratedTerminal` 0, `diff pane`/`DiffPane` 0, `stage hunk`/`stageHunk` 0, `GitPanel`/`gitPanel` 0,
`createPullRequest` 0. Positive control on the same run: `EnterWorktree` 31, `SKILL.md` 150.

- **VERDICT:** `take the contract` for per-platform setup scripts (small); `record the divergence as
  deliberate` for the `.codex`-checked-in location; **`not our surface`** for Actions, the integrated
  terminal and the built-in Git panel — this product's Git story is the agent's own tools plus the user's
  IDE, and building an in-app diff/stage/commit/PR surface is a product direction, not a doc gap. That
  verdict has never been written down anywhere, which is why the row was 🟥.
- **KIND:** `forgotten vs doc-parity` for the platform scripts; `never looked at` for the Actions/terminal/
  Git-panel verdict (nobody has ever recorded a decision on them).
- **COST:** per-platform setup scripts: `config/worktree-settings.ts` (three optional sibling keys + the
  precedence rule, ~30 lines) and one branch in `worktree-setup-plan.ts` (~5 lines) + 2 tests. Actions /
  terminal / Git panel: unknown and large; do not cost them until the owner says they are wanted.
- **CITATION:** `learn.chatgpt.com/docs/environments/local-environment.md#setup-scripts` —
  "Setup scripts run automatically when Codex creates a new worktree at the start of a new chat."

---

## Row 66 — `environments/git-worktrees` (map 🟨)

**HEAD-STATUS:** `map STALE in its probe, correct in its conclusion. It reported "handoff|hand off — ни
одного релевантного попадания"; at HEAD handoff files=87 / Handoff 44 — but every hit is the RUNTIME-SWITCH
handoff (server-core/src/sessions/runtime-switch.ts:199,215,365,393), a different concept. The Local↔Worktree
Handoff is still absent.`
**Tag:** `[doc:codex]+[doc:claude]` — the subsystem was built to Claude's `worktrees.md` and
`large-codebases.md`; the code comments still cite `worktrees.md:150-162`, `:128`, `large-codebases.md:245`.

Built and real: `.worktreeinclude` (`worktree-include-plan.ts`, full gitignore-semantics parser),
`worktree-lease-service.ts`, `worktree-git-plan.ts`, the approval UI. **Absent at HEAD, re-probed:**

| page clause | probe |
| --- | --- |
| Handoff Local↔Worktree, "Hand off" in the chat header | 0 relevant (all 87 hits are runtime-switch) |
| "Create branch here" | no such control (`gitPanel`/`createPullRequest` 0) |
| Permanent worktrees | `permanent worktree` 0 |
| "keeps your most recent 15" count limit | `maxWorktrees` 0, `worktreeLimit` 0 — our sweep is **age**-based (`worktree-lease-service.ts:213-275`, "Remove orphaned worktrees on the retention cutoff"), not count-based |
| snapshot before delete + restore | no snapshot-before-delete on that path (`snapshot` files=412, all unrelated — this is a mention count, and I checked the sweep: `:240-275` removes without snapshotting) |
| auto-copy of ignored `AGENTS.override.md` | `AGENTS.override.md` files=0 |

- **VERDICT:** `take the contract` for `AGENTS.override.md` auto-copy and the snapshot-before-delete
  (both are data-loss-adjacent and cheap); `record the divergence as deliberate` for the retention model
  (age cutoff vs "most recent 15" — ours is a real alternative, just never written down as a divergence);
  `not our surface` for Handoff / "Create branch here" / permanent worktrees, which are chat-header UI on a
  product surface we do not have.
- **COST:** `AGENTS.override.md` auto-copy — one entry in `worktree-include-plan.ts`'s implicit set
  (~5 lines + 1 test). Snapshot-before-delete — a real change to
  `worktree-lease-service.ts:240-275` (bundle the worktree's uncommitted diff before `git.remove`, ~60
  lines) plus a restore path and a place to keep it; unknown where the snapshot should live. Handoff:
  unknown, large, and gated on row 64's picker.
- **KIND:** `forgotten vs doc-parity`
- **CITATION:** `learn.chatgpt.com/docs/environments/git-worktrees.md#worktree-cleanup` —
  "Before deleting a Codex-managed worktree, Codex saves a snapshot of the work on it."

---

## Row 67 — `extend/mcp` (map 🟨)

**HEAD-STATUS:** `map still correct — and I nearly recorded a false drift. enabled_tools/disabled_tools
now appear in config-writer.ts, but ONLY as a comment (:642-643) explaining that codex has no per-role tool
allowlist. Nothing is emitted. Likewise approval_mode's one non-test hit (approval-bridge.ts:226) is a
comment.`
**Tag:** `[doc:codex]`

What we WRITE into `config.toml` is unchanged from the map: exactly two servers —
`[mcp_servers.session]` with `command`/`args`/`env` (`config-writer.ts:1016-1025`) and
`[mcp_servers.sources]` with `url`/`bearer_token_env_var` (`:1029-1034`). Everything else runs through our
own pool.

**One genuine refinement the map did not have:** of the page's `#### Other configuration options` we now
*read* `tool_timeout_sec` — but from a **plugin's codex manifest**, not from config.toml, and only to
validate it: `plugins/format-adapters/codex.ts:1004` reads `rawServer.tool_timeout_sec` and `:1021-1022`
emits "Codex MCP tool_timeout_sec must be an integer between 1 and 86400." So the field is understood on
the plugin-ingest path and dropped on the config-emit path. `startup_timeout_sec` 0, `http_headers` 0,
`env_http_headers` 0, `default_tools_approval_mode` (production) 0, `enabled_tools`/`disabled_tools`
(production emit) 0, `required` not emitted. Positive control: `mcp_servers` files=31, `bearer_token_env_var` 7.

The page's `plugins.<plugin>.mcp_servers.<server>` user-override table is unimplemented on both sides —
we neither write nor honour it.

- **VERDICT:** `take the contract` for the timeout and tool-policy keys (`startup_timeout_sec`,
  `tool_timeout_sec`, `enabled_tools`/`disabled_tools`, `default_tools_approval_mode`, `required`) on the
  two servers we own; `record the divergence as deliberate` for project `.codex/config.toml` (the page's
  own "trusted projects only" framing, and our refusal is pinned by `project-config.test.ts:46`);
  `not our surface` for the CLI `codex mcp add` flow and the TUI.
- **KIND:** `forgotten vs doc-parity`
- **COST:** `packages/codex-responses-adapter/src/config-writer.ts` — optional key emission on the two
  server blocks, ~20 lines + the schema drift-guard pattern already at `:1107-1113`, + ~3 tests in
  `config-writer.test.ts`. The `tool_timeout_sec` case is nearly free: the value is already parsed and
  validated on the plugin path (`format-adapters/codex.ts:1004`), so plumbing it to the writer is short.
  Honouring `plugins.<plugin>.mcp_servers.<server>` is a larger, separate piece — unknown.
- **CITATION:** `learn.chatgpt.com/docs/extend/mcp.md#other-configuration-options` —
  "`tool_timeout_sec` (optional): Timeout (seconds) for the server to run a tool. Default: `60`."

---

## NOT-MEASURED (declared, not padded)

- **Row 62 — whether `gpt-5.6-terra` / `gpt-5.6-luna` resolve in the shipped Pi catalog.** The file's own
  rule (`llm-connections.ts:845-846`) is that every candidate must be verified present, and verifying it
  needs the catalog, not a grep. The fix is blocked on this check. WHY not done: read-only lane, no
  runtime spawn.
- **Row 53 — no live/packaged verification.** Everything is source-level. The "Managed" indicator, the
  menu item staying visible, and the launch-check hole were read from source and tests, never seen on a
  packaged build. Per this repo's own rule, a dev build is not the shipped artifact.
- **Row 55 — whether our plugin install path implicitly grants a connector.** That is the one question on
  the page that could be a security finding, and answering it needs a walk through
  `capabilities/resolver.ts` deeper than a coverage re-triage. Named, not answered.
- **Row 66 — `snapshot` files=412 was not individually triaged.** I checked the deletion path
  (`worktree-lease-service.ts:240-275`) and found no snapshot there, which is what the claim rests on; I
  did not rule out a snapshot facility elsewhere that a future change could reuse.
- **Row 54 — the shipped app-server's actual `configRequirements/read` payload was not observed.** The
  field list is from the generated binding, which `codex-config-requirements.ts` itself warns "lag the
  binary". If the shipped binary returns more fields, the honoured fraction is smaller than 1-of-22.

---

# LANE D — rows 75, 78, 79, 80, 81, 83, 85, 87, 89, 91

HEAD at measurement: `b1824c4b4334256bc678cf6e932bac81e9d1b222` (the brief's audited SHA
`f58f66a36` had already moved; every measurement below is against b1824c4b4).
Method: `probe.sh` / `git grep -a` only, never `rg`. Every "present at HEAD" claim below is
pinned to a CALL SITE or a dispatch arm, not to a name in a docblock (peer correction accepted).

**Two of my four 🟥 rows are WRONG at HEAD, not merely stale — rows 78 and 80 describe
absences that are built and shipping.** One 🟨 (row 89) is stale on its central claim.
Rows 75, 79, 81, 83, 85, 87, 91 re-probe as the map describes them.

---

## Row 75 — `glossary` (map 🟨)

HEAD-STATUS: `map still correct`
[doc:codex]

VERDICT: **not our surface**
KIND: **never looked at** — no plan, spec, or commit has ever consumed this page; the coverage
map's own row (2026-08-22) is the sole examination, and it produced no downstream action.

Re-measured: `grep -c 'key:' md/glossary.md` = **116** — unchanged shape, an index of one-line
definitions each pointing at another page. It carries no requirement on any surface: every
normative sentence lives on the page the entry links to (`Thread` → `/codex/app-server#threads`,
`Turn` → `/codex/app-server#core-primitives`, `Codex app-server` → `/codex/app-server`). Taking
"the contract of the glossary" would mean taking `app-server`'s contract, which is a different
row. The one thing it could be used for — checking our USER-FACING vocabulary against codex's
(we say "session" where codex says "Thread"/"Turn") — is a copy question with no measured defect
behind it, and I am not inventing one.

COST: zero to close as `not our surface`. If the owner ever wants the vocabulary check instead,
that is a docs/i18n pass over the renderer strings, not a code change — unknown size, no
dependency.

CITATION: `[doc:codex] no normative sentence — navigational page`. The page's whole body is one
`<GlossaryTable>` component; `anchors/glossary.txt` contains exactly one non-chrome id
(`mainContent`), i.e. it publishes NO section anchor at all, which is itself the evidence that it
has no normative sections. Nearest thing to a normative sentence is the intro line before any
heading: "Use this glossary as a quick reference for Codex terms across the app, CLI, IDE
extension, cloud, SDK, and related integrations."

---

## Row 78 — `image-generation` (map 🟥)

HEAD-STATUS: **`map WRONG:`** the cell's load-bearing claim — "Обрабатывает их НИКТО … молча уходит
в `default:`" — was **already false on the day the map was written**. `f785353f5`
*fix(codex): image items render instead of vanishing* is dated **2026-08-22**, the map's own date;
`06ca21018` and `92d6e8cc1` (per-message identity) and `ccaa10491`/`b7805de0c` follow. The map's
second claim — "это ограничение нигде не записано как отклонение" — is also now false.

[doc:codex]

VERDICT: **record the divergence as deliberate** (the contract is TAKEN; what remains is a
reachability limitation that is now written down)
KIND: **bug** — in the map, not in the code. The row is a false 🟥.

What is actually at HEAD, by call site (not by docblock):
- `packages/shared/src/agent/backend/codex/event-adapter.ts:841` — `case 'item/started'`:
  `if (isImageItem(item)) return this.renderImageItem(item, 'started', p)`
- `…/event-adapter.ts:892` — `case 'item/completed'`: the same dispatch for `'completed'`
- `…/event-adapter.ts:784` `renderImageItem` (once-per-`${type}:${id}` dedupe) →
  `:332` `imageItemEvents`, which emits a ```` ```image-preview ```` fence
  (`:282 imagePreviewBlock`) via `text_complete` for a real `savedPath`/`path`, prefixes it with
  `revisedPrompt` as the caption, and emits a DURABLE `info` + `level:'warning'` for the three
  dead ends (blank path, `failure`/`status:'failed'`, completed-with-no-path) — all three
  phase-gated so a `started` notification cannot retire an item whose `completed` carries the
  real path.
- Renderer end of the fence is real too: `packages/ui/src/components/markdown/Markdown.tsx:302`
  and `:440` route `image-preview` to `MarkdownImageBlock`.
- Tests: `packages/shared/src/agent/__tests__/codex-event-adapter.test.ts` (:448-:564) and
  `apps/electron/src/renderer/event-processor/__tests__/codex-per-message-identity.test.ts`.
- Probe: `imageGeneration` / `imageView` / `ImageGenerationItem` / `revisedPrompt` = **3 files
  each** (1 production + 2 tests), `savedPath` = 4 (the fourth is pi's `web-fetch.ts`).
  Positive controls on the same run: `sandbox_mode` = 6, `CODEX_HOME` = 27.

What is genuinely NOT taken, and why each is small:
1. **Reachability.** `config-writer.ts:996` still pins `base_url = "http://127.0.0.1:<port>/v1"`
   to the loopback adapter over a gateway with no image model. This is now RECORDED, contra the
   map: `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:501` —
   "No feature enablement (gateway has no image model)." So the whole handler is dormant on the
   default connection and lights up only on a BYO upstream that serves images.
2. `$imagegen` — probe `imagegen` = **0 files**. This is a skill token the user types into the
   prompt and codex resolves internally; nothing on our side has to exist for it. Not a gap.
3. `gpt-image-2` — probe `gpt-image` = **0 files**, and `image_generation` / `view_image` /
   `imageGenerationEnabled` = **0 files** each: we write no image-tool enablement into
   `config.toml`. Consistent with (1).
4. Reference-image attachment (`-i` / `--image`) is row 79's subject, not this row's.

COST: nothing owed for the item contract. If the owner ever wants (1) lifted, it is a
config-writer key plus a model-catalog capability flag — small, but pointless before an upstream
serves images. Recommend the map row be corrected to 🟩-with-a-recorded-limitation rather than
re-opened.

CITATION: `learn.chatgpt.com/docs/image-generation.md#generate-or-edit-an-image` — "Built-in image generation uses
`gpt-image-2` and counts toward your general Codex usage limits."

---

## Row 79 — `image-inputs` (map 🟨)

HEAD-STATUS: `map still correct`
[doc:codex]

VERDICT: **take the contract**
KIND: **forgotten vs doc-parity**

Re-measured, unchanged at HEAD:
- `packages/shared/src/agent/codex-agent.ts:2610` — `chatImpl(message, _attachments?: FileAttachment[], options?)`.
  The underscore is the whole finding: the parameter is declared and never read. I grepped the
  entire file for `attachments` — **one hit, that line**. Nothing else in `codex-agent.ts` touches
  an attachment.
- `packages/shared/src/agent/backend/composer-capabilities.ts:54-55` — `'codex-runtime': { images: 'per-model', … }`.
  So the composer OFFERS image attachment on codex and the agent drops it. That is the divergence:
  not "unsupported", but *advertised and silently discarded*.
- The one path an image does cross is the runtime switch, as a PATH string:
  `apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts:127` —
  "an image attachment crosses as a PATH".
- Probe: `isImageAttachment` 3, `filterAttachmentsForModelInput` 4, `supportsImages` 42,
  `FileAttachment` 40 — the machinery exists everywhere else.

Severity note: this is a **silent user-visible loss**, not a cosmetic gap. A user drops a
screenshot onto a codex chat, the composer accepts it (because `images: 'per-model'` resolves
true for a vision model), and the model never sees it. No warning is emitted.

COST: `packages/shared/src/agent/codex-agent.ts` — read `attachments`, and either (a) map image
attachments into the `turn/start` input items the app-server accepts, or (b) the honest cheap fix:
flip `codex-runtime` to `images: 'no'` in `composer-capabilities.ts:54` so the composer stops
accepting what we throw away. (a) ≈ 40-80 lines + 2 tests + one live smoke against the shipped
binary and depends on the adapter forwarding image content parts upstream; (b) ≈ 2 lines + 1 test.
(b) is worth doing regardless of whether (a) is ever scheduled.

CITATION: `learn.chatgpt.com/docs/image-inputs.md#cli` (the `cli` ContentModeSwitch anchor; the sentence sits in that
switch, before the page's first `##`) — "Paste an image into the interactive composer, or pass one
or more files on the command line:" followed by
`codex -i screenshot.png "Explain this error and suggest the smallest fix"`.

---

## Row 80 — `import` (map 🟥)

HEAD-STATUS: **`map WRONG:`** "У нас такого потока нет … шага импорта нет" is false at HEAD.
A Settings > Import flow exists and ships: `e815ad274` *feat(onboarding): import a Claude Code
setup* (2026-08-24), + `1338dd509`, `6a854bd1c`. The map's own probe token was the wrong one — it
searched `importClaude|/import|importAgentSetup`; at HEAD `importClaude` = **6 files** and the two
IPC channels are literally named `workspace:importClaudePreview` / `workspace:importClaudeApply`.

[doc:codex]

VERDICT: **take the contract** (for the residual only — the core is taken)
KIND: **bug** in the map for the built half; **forgotten vs doc-parity** for the residual. Scoring
one: **forgotten vs doc-parity**, because the residual is what the tracker still needs.

What exists at HEAD, by call site:
- `packages/shared/src/capabilities/claude-setup-import.ts` (833 lines) — a two-phase converter,
  `computeClaudeSetupImportPlan` (dry-run, writes nothing) → `applyClaudeSetupImportPlan`.
  Five kinds: `'instruction' | 'permission' | 'skill' | 'mcp' | 'hook'` (`:60`).
- Handlers: `packages/server-core/src/handlers/rpc/sources.ts:87` and `:96`.
- Channels: `packages/shared/src/protocol/channels.ts:313-314`; renderer bridge
  `apps/electron/src/transport/channel-map.ts:273-274`.
- UI: `apps/electron/src/renderer/pages/settings/ImportSettingsPage.tsx` — a real
  **Settings → Import** page (`meta.slug = 'import'`), hosting
  `components/import/ClaudeImportContainer.tsx` (scan → preview → confirm).
- Tracked: `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1142` (P2.9).

Mapping to the page's destination table — measured, kind by kind:
| Page row | HEAD |
| --- | --- |
| Instruction files → `AGENTS.md` | **taken** — `~/.claude/CLAUDE.md` merge-block into `<ws>/AGENTS.md` (`:595-:600`) |
| `settings.json` → `config.toml` | **taken by equivalence, not literally** — the Claude `permissions` block lands in Nessy workspace permissions and the `hooks` block in `<ws>/hooks.json`; `config.toml` is then generated from those by `config-writer.ts`. Probe `settings.json` in `codex-responses-adapter/src` = still 0, as the map said, and that stays correct-by-design |
| Skills | **taken** — `skillRecords` on `~/.claude/skills` → `<ws>/skills/<slug>/` |
| MCP server configuration | **taken** — `mcpServerRecords` on `~/.claude.json` / `~/.claude/.mcp.json` → `saveSourceConfig` |
| Hooks | **taken** — `parseHooksConfigContent` → `<ws>/hooks.json` |
| Plugins | **NOT taken** |
| Existing project folders → Projects | **NOT taken** |
| Project memories from Claude Code | **NOT taken** |
| Chats from the last 30 days | **NOT taken** |
| Slash commands → Skills | **NOT taken** (`commands/` explicitly out of scope, module header) |
| Subagents | **NOT taken** (`agents/` explicitly out of scope, module header) |

Also not taken, both named by the page: **sources other than Claude Code** — Cursor and Claude
Cowork (the module header records "Cursor is deferred (Dev-13) and is not read here"); and
**"Keep imported work in sync"** — no automatic updates and no import history
(`ImportSettingsPage.tsx` + `ClaudeImportContainer.tsx` contain no such control; grepped for
`automatic update|importHistory|auto-update|sync` → 0).

The map's one genuinely durable observation survives: the page's CLI half excludes our topology
("The `/import` command isn't available … while connected to a local app-server daemon"), so only
the DESKTOP half of this page is ours — and the desktop half is the half that is now built.

COST: residual only. `agents/` + `commands/` are the cheapest (both readers already exist in
`plugins/format-adapters/claude.ts`; ≈ 60-120 lines in `claude-setup-import.ts` + 2 tests each).
Cursor as a second source = a new reader, unknown, gated on Dev-13. Chats/projects/memories =
large and cross-cutting (session store + workspace registry), unknown. Auto-update + history =
a stored manifest of the last applied plan plus a scheduler hook, ≈ 100-200 lines, no external
dependency.

CITATION: `learn.chatgpt.com/docs/import.md#import-in-the-desktop-app` — "In the ChatGPT desktop app, open **Settings >
Import**. If **Import** isn't available as a settings section yet, open **General** and find
**Import other agent setup**."

---

## Row 81 — `integrated-terminal` (map 🟥)

HEAD-STATUS: **`map still correct`** — and I want to be precise, because four commits since the
map have the word "terminal" in their subject and NONE of them is this page's subject.

[doc:codex]

VERDICT: **record the divergence as deliberate**
KIND: **forgotten vs doc-parity** — the verdict exists (parity-audit:1787-1789) but it was rendered
against the CLAUDE `desktop` page, never against this one, so this page's contract has never been
adjudicated on its own terms.
Tag correction: `[doc:codex]+[doc:claude]` — the standing "product decision, not loop parity"
verdict that covers this feature was written against Claude's `desktop` page.

**What a "codex terminal" is at HEAD — measured, not inferred.** `0c98c9349`
*background terminals appear as background tasks* (2026-08-24), `44b7eadab`, `bf6d8434c`
(2026-08-24), `33901a82b` *Stop could not stop a codex terminal* (2026-08-26) implement an
**app-server-side background process registry**, driven over JSON-RPC:
- `packages/shared/src/agent/codex-agent.ts:1698` — `client.request('thread/backgroundTerminals/list', …)`,
  polled at each TURN BOUNDARY (`:2814`, before `turn/start`), paged, never throwing.
- `…/codex-agent.ts:2998` — `'thread/backgroundTerminals/terminate'`, reached from
  `AgentInstance.stopBackgroundTask`.
- `packages/server-core/src/sessions/SessionManager.ts:22785` (`killShell`) — routes a
  non-Pi process handle to that lever and reads `terminated:false` honestly instead of rounding up.
- Surface: each such terminal becomes a **background-task chip**, i.e. a row in the existing
  task list. It is a *thing the agent started that is still running*.

**What the page is about.** An INTERACTIVE terminal the HUMAN types into: "Each chat in the
ChatGPT desktop app includes a terminal scoped to its current project or worktree", opened with
Ctrl+`, cleared with Ctrl+L, readable by the model, and the target that local-environment
`actions` run in.

**Verdict on the page's contract: still UNTAKEN, and not partly taken.** The two features share
a noun and nothing else — one is a chip listing processes the agent spawned, the other is a
keyboard-driven shell the user drives. Measured:
- `node-pty` = **0 files**; no terminal-emulator dependency in ANY tracked `package.json`
  (`git grep -a -n -E '"(node-pty|@xterm/[a-z-]+|xterm)"' -- '**/package.json'` → no hits).
- `xterm` = 2 files and BOTH are false positives, exactly the failure mode the peer warned about:
  `apps/electron/src/main/shell-env.ts:55` (`TERM: 'xterm-256color'`) and
  `packages/shared/src/agent/pi-harness/claude-bash-rule.test.ts:1438` (a rule fixture,
  `man --html=xterm ls`).
- `writeStdin` = 0. The only "terminal" component,
  `packages/ui/src/components/terminal/TerminalOutput.tsx` (222 lines), is display-only — its
  props are `command`/`output`/`exitCode`/`toolType`/`description`/`theme`, and the file contains
  no `<input>`, no `<textarea>`, no `onKeyDown`, no `stdin`.

So: **untaken**, and the background-terminal work does not move it one inch.

COST: real and large. An interactive terminal means a pty binding (`node-pty` — a native module
that must be rebuilt per Electron ABI and signed on all three platforms), a renderer emulator, a
main↔renderer stream channel, scoping to the chat's project/worktree, plus the model-reads-output
path. This is a multi-week feature touching packaging, signing and the ulimit-bound fd budget
already recorded as a trap in AGENTS.md. Order of magnitude: unknown, but not less than
"one plan of its own". My recommendation is that this stays a recorded deliberate divergence and
that the record be moved to name THIS page.

CITATION: the defining sentence sits in the page intro, before the first heading, so per the
brief I name that and cite the nearest normative section:
`learn.chatgpt.com/docs/integrated-terminal.md#run-and-validate-your-project` — "Use the terminal to validate changes,
run scripts, and perform Git operations without switching apps." (Intro sentence, uncited-by-anchor:
"Each chat in the ChatGPT desktop app includes a terminal scoped to its current project or worktree.")

---

## Row 83 — `long-running-work` (map 🟨)

HEAD-STATUS: `map still correct`
[doc:codex]+[doc:claude] — our goal subject was built against Claude's `goal` page
(`specs/2026-08-02-claude-doc-sweep-divergences.md:530`), which is why this page's own vocabulary
was never taken.

VERDICT: **take the contract**
KIND: **forgotten vs doc-parity**

Re-measured at HEAD, all three of the map's claims hold:
- The engine exists: `GoalService` = **18 files**, `goal_create` / `goal_replace` / `goal_cancel`
  = 3-5 files each, `continuationPrompt` = 3.
- `'/goal'` = **0 files**, `goalMode` = **0 files**. There is no `/goal` and no `/plan`; the
  slash-command registry is `packages/shared/src/slash-commands/` (btw, custom-commands,
  session-command, subtask) and contains neither.
- No goal UI: `git grep -a -I -l -iE "'goal|goal'" apps/electron/src/renderer` → **no hits**;
  `GoalBanner` = 0, `goalSnapshot` = 0. The page's "goal progress row … above the composer" with
  pause / resume / edit / clear does not exist; control is RPC-only.

So the capability is real and the two USER-FACING affordances the page specifies — the entry point
and the progress row — are both absent. A user cannot start or steer a goal from the app at all.

COST: `/goal` + `/plan` in `packages/shared/src/slash-commands/session-command.ts` routed to the
existing `goal_create`/`goal_replace`/`goal_cancel` RPC ≈ 60-100 lines + 2 tests, no new backend.
The progress row is a renderer component above the composer bound to the existing goal snapshot in
`packages/core/src/types/pi-harness-runtime.ts` ≈ 150-250 lines + i18n keys in all locales +
playground entries (the playground-is-a-design-surface rule applies). Depends on nothing new.

CITATION: `learn.chatgpt.com/docs/long-running-work.md#start-a-goal` — "Type `/goal` in the ChatGPT desktop app, Codex
CLI, or the IDE extension." (For the progress row: `#steer-a-running-goal` — "In the ChatGPT
desktop app, the goal progress row appears above the composer. Use it to pause or resume work,
edit the goal, or clear it.")

---

## Row 85 — `models` (map 🟨)

HEAD-STATUS: **`map STALE:`** not our code — **the PAGE moved**. The map quoted the deprecation
sentence as "`gpt-5.2` and `gpt-5.3-codex` … already deprecated"; the page now leads that section
with a NEW retirement: "The `gpt-5.4` and `gpt-5.4-mini` models retire from Codex with ChatGPT
sign-in on August 31, 2026." Our two divergences are unchanged in code and WIDER in effect.

[doc:codex]

VERDICT: **take the contract**
KIND: **forgotten vs doc-parity**

Re-measured at HEAD:
1. **Effort collapse — unchanged.** `packages/codex-responses-adapter/src/config-writer.ts:236-243`
   `REASONING_EFFORT` still maps `xhigh: 'high'` and `max: 'high'`; consumed at `:720` →
   `model_reasoning_effort` in the per-role TOML. Meanwhile `xhigh` = **43 files** in our tree, so
   the level is a first-class product concept that flattens at the codex boundary. The page names
   four things we cannot distinguish there: **High**, **Extra High**, **Max**, **Ultra**.
2. **Catalogue — unchanged and now further behind.** `packages/shared/src/config/llm-connections.ts:819-820`
   still reads `['gpt-5.5','gpt-5.2','gpt-5.1','gpt-5','o4-mini','o3','gpt-4o']` for both `openai`
   and `openai-codex`; `:869-870` mini-lists `gpt-5.4-mini`. Probe `gpt-5.6` = **0 files**. So the
   fallback catalogue offers `gpt-5.2` (deprecated per the page), lists `gpt-5.4-mini` (retiring
   2026-08-31 per the page), and has never heard of the `gpt-5.6` Sol/Terra/Luna family the page
   now recommends by default ("Start with the default Power setting, which uses `gpt-5.6-sol`").

Severity note: (2) has a date on it. `gpt-5.4-mini` is our `openai-codex` mini default and the page
gives it a retirement date of **2026-08-31 — three days from this measurement**. Whether that
bites depends on the upstream a user configures (our default connection is the Nestor gateway,
not ChatGPT sign-in), but any BYO ChatGPT-auth codex connection using our fallback list breaks on
that date.

COST: (2) is a data edit — `llm-connections.ts:819-820` and `:869-870`, add the `gpt-5.6-*` family,
drop `gpt-5.2`, replace `gpt-5.4-mini`; ≈ 10 lines + the catalogue test. Cheap and dated, so do it
first. (1) is harder and may be a genuine "record as deliberate": codex's `ReasoningEffort` enum in
`packages/codex-protocol/schema/config-schema.json` is the authority on whether `xhigh` exists
upstream — I did NOT re-probe the pinned binary's enum, so the honest disposition of (1) waits on
that. NOT-MEASURED, below.

CITATION: `learn.chatgpt.com/docs/models.md#pick-a-reasoning-effort` — "**High** and **Extra High** suit difficult work
with multiple steps, sources, or tradeoffs." (For (2): `learn.chatgpt.com/docs/models.md#deprecated-codex-models` — "The
`gpt-5.4` and `gpt-5.4-mini` models retire from Codex with ChatGPT sign-in on August 31, 2026.")

NOT-MEASURED: whether the pinned codex binary's `ReasoningEffort` enum actually accepts `xhigh`
(and what codex calls Max/Ultra on the wire). Without that, I cannot say whether the collapse at
`config-writer.ts:241-242` is a gap we could close or a faithful mapping to a narrower upstream
enum. Deciding it needs a schema read plus a live probe of the shipped binary — out of a read-only
lane's budget.

---

## Row 87 — `notifications` (map 🟨)

HEAD-STATUS: `map still correct`
[doc:codex]

VERDICT: **take the contract**
KIND: **forgotten vs doc-parity**

Re-measured at HEAD, all unchanged:
- One boolean, not three positions: `packages/shared/src/config/config-defaults-schema.ts:15`
  `notificationsEnabled: boolean`, rendered as a single `SettingsToggle` at
  `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx:302-307`
  (`settings.notifications.desktopNotifications`). `notificationsEnabled` = 9 files.
- The "background only" behaviour is hard-coded, not chosen: `apps/electron/src/main/notifications.ts:5`
  ("when app is not focused") and `:167` `window.isFocused()`. The page's "never / only while in
  the background / always" is a three-position control; we ship position two, permanently.
- No separate permission-and-question toggle: grepping `notifications.ts` for
  `permission|question` returns only a comment about multi-window ambiguity (`:163`), nothing
  behavioural.
- CLI half: we write **no** external `notify` program into the codex config —
  `git grep -a -n -w 'notify' packages/codex-responses-adapter/src/` → **no hits**, and
  `tui_notifications` → 0. The map's finding that the only `notify` in codex-agent is
  `client.notify('initialized')` (JSON-RPC) holds.
- Activity view (bell, Cmd+Opt+U) and Pets are ChatGPT-app surfaces; correctly not ours.

COST: three-position control = one enum setting replacing the boolean, threaded through
`config-defaults-schema.ts`, `storage.ts`, `validators.ts`, the settings page, and
`notifications.ts`'s focus check, ≈ 80-120 lines + i18n keys in ALL locales + a migration for the
existing boolean. Separate permission/question notifications = a second setting plus a call site
where permission requests are raised, ≈ 60 lines + i18n. External `notify` program for codex =
one key in `config-writer.ts` + a test, ≈ 20 lines — but see the caveat: it would run a
user-specified program, so it needs the same treatment as any other command-execution setting.

CITATION: `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` — "Open [**Settings**](codex://settings)
to choose whether turn-completion alerts appear never, only while ChatGPT is in the background, or
always. Separate controls let you turn permission and question notifications on or off."

---

## Row 89 — `permission-modes` (map 🟨)

HEAD-STATUS: **`map STALE:`** the cell's closing claim — "`Approve for me`/Auto-review как режим у
нас не выражен (`approvals_reviewer` не пишется)" — is false at HEAD. `384e2fb38` (machinery) +
`7736e32a9` (wiring), both 2026-08-24, land it. Tracked at
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1432` (P3.2, closed).

[doc:codex]

VERDICT: **take the contract** (the residual: the page's MODE model, not the mechanism)
KIND: **forgotten vs doc-parity**

**Auto-review at HEAD, by call site:** `packages/codex-responses-adapter/src/config-writer.ts:953`
emits `approvals_reviewer = "auto_review"`, gated on `emitAutoReview`; `:1145-:1158` validates the
value against the pinned `config-schema.json` enum and throws if the key or member is missing.
`[auto_review].policy` rides alongside. Setting: `codexAutoReviewEnabled` (5 files) —
`config-defaults-schema.ts:47`, `storage.ts:197-198,255,1755-1759`, `validators.ts:135,275`,
default **false** (`apps/electron/resources/config-defaults.json:20`). Wiring + `/approve`
override + a codex-local denial breaker: `codex-agent.ts`, `backend/codex/auto-review-breaker.ts`,
tests `codex-auto-review-wiring.test.ts` / `codex-auto-review-breaker.test.ts`.

**Now the whole seven-mode mapping, re-measured against the page's vocabulary.** The page defines
exactly three modes and a two-control model. `CODEX_PERMISSION_MODE_TABLE`
(`config-writer.ts:316-341`) with the sandbox master switch **ON**:

| Nessy mode | `sandbox_mode` | `approval_policy` | Page's mode |
| --- | --- | --- | --- |
| `dontAsk` | `read-only` | `never` | none — stricter than any page mode |
| `explore` | `read-only` | `on-request` | none |
| `plan` | `read-only` | `on-request` | none (codex has no plan mode; collapses onto `explore`) |
| `default` | `workspace-write` | `on-request` | **Ask for approval** |
| `acceptEdits` | `workspace-write` | `on-request` | **Ask for approval** (identical row) |
| `auto` | `workspace-write` | `on-request` | **Ask for approval** (identical row) |
| `bypassPermissions` | `workspace-write` | `on-request` | **NOT Full access** — identical row again |

Two findings the map did not state:
1. **"Full access" is not expressible even with the sandbox on.** `bypassPermissions` emits the
   same pair as `default`. Four of our seven modes are byte-identical on the codex side.
2. **At the SHIPPED default the sandbox control vanishes entirely.**
   `SANDBOX_ENABLED_DEFAULT = false` (`packages/shared/src/config/sandbox-settings.ts:353`,
   owner decision 2026-08-12), so `codexSandboxConfigForMode(mode, false)` (`:388-407`) returns
   `sandbox_mode: 'danger-full-access'` for EVERY mode, with only `dontAsk`'s `never` degrading to
   `untrusted` (R13). The page's model is "sandbox defines what you can reach, approvals define
   when it pauses"; ours ships with the first half constant and Nessy's own PolicyEngine
   substituting for it.
   This IS recorded — `docs/architecture/runtime-capability-gaps.md`, the "Nothing of ours inspects
   a tool call before Codex runs it" row: "With the sandbox master switch off — the shipped default
   since 2026-08-12 — six of the seven modes emit the identical `danger-full-access` / `on-request`
   pair, so the configuration does not distinguish them either." So (2) is a **deliberate,
   documented** divergence. (1) is not documented anywhere I found.

**What is left of this page's contract:**
- **Auto-review is a hidden global setting, not a mode.** The page puts it in the permissions
  control below the composer, enabled per-mode from Settings > General. Ours has **no UI at all**:
  `git grep -a -I -l -E 'codexAutoReview|autoReview' apps/electron/src packages/ui/src` → **no
  hits**. It is reachable only by editing config. The page's "Enabling a mode makes it available in
  the menu; it doesn't select the mode" has a real analogue in our code
  (`composer-permission-modes.ts:248` `PICKER_HIDDEN_MODES`, `:250` `getVisibleComposerPermissionModes`)
  — the visibility mechanism exists, auto-review just is not plugged into it.
- `/permissions` — the page's CLI entry point. Not present; the registry
  (`packages/shared/src/slash-commands/`) has no `permissions` command. Our equivalent is the
  composer picker, which is what the page prescribes for the app surface, so I do not count this
  as a gap.

COST: surfacing auto-review as a picker entry ≈ a mode-or-toggle decision first (it is orthogonal
to the mode by the page's own rule — "Changing who reviews a request doesn't expand the sandbox"),
then `composer-permission-modes.ts` + the settings page + i18n in all locales, ≈ 120-200 lines +
tests + playground entries. Making `bypassPermissions` mean `danger-full-access` when the sandbox
is on is a 1-line table change with a large blast radius — it is the loosest configuration the
product can emit, and it wants the owner, not an executor.

CITATION: `learn.chatgpt.com/docs/permission-modes.md#how-permissions-work` — "Changing who reviews a request doesn't
expand the sandbox." (For the mode vocabulary: `learn.chatgpt.com/docs/permission-modes.md#enable-modes` — "To add
**Approve for me** (called **Auto-review** in settings) or **Full access** to the permissions menu,
open **Settings > General** in the ChatGPT desktop app, then turn on the mode under
**Permissions**.")

---

## Row 91 — `personalize` (map 🟨)

HEAD-STATUS: `map still correct` — and one of its facts is now SHARPER than the map states.
[doc:codex]

VERDICT: **take the contract** (the personality half only)
KIND: **forgotten vs doc-parity**

Re-measured at HEAD:
- Memory half **built and unchanged**: `packages/session-tools-core/src/tool-defs.ts:1092-1093`
  registers `update_user_preferences` and `remember`; store is
  `packages/shared/src/config/preferences.ts` (238 lines).
- Personality: `Personality` / `personality` = **0 files** in our source (probe excludes
  `packages/codex-protocol/generated`). Unchanged.
- **Sharpening the map.** The map said the type "есть только в сгенерированном
  `generated/Personality.ts`". Measured, it is on FOUR wire shapes we actually drive:
  `generated/v2/ThreadStartParams.ts:16` (`personality?: Personality | null`),
  `generated/v2/TurnStartParams.ts:41` (docblock at `:39`: "Override the personality for this turn
  and subsequent turns."), `generated/v2/ThreadSettings.ts:14`, and `ThreadResumeParams.ts`.
  We call **both** of those methods: `codex-agent.ts:1381` and `:2432` (`thread/start`, passing
  only `cwd`/`model`/`config`) and `:2892` (`turn/start`). So this is not "a type in a generated
  file nobody uses" — it is an optional field on a request we send every session, left `undefined`.
  That makes it materially cheaper than the map implies.
- Custom instructions → global `AGENTS.md`: opening it stays codex's ("Theirs" in
  `docs/architecture/runtime-control-boundary.md`). Correct, not a gap.
- Computer History: macOS ChatGPT-app feature, not our host. `not our surface` for that sub-item.

COST: small and bounded. A `personality` setting (`config-defaults-schema.ts` + `storage.ts` +
`validators.ts`), threaded into the `thread/start` params at `codex-agent.ts:1381`/`:2432` and
optionally `turn/start` at `:2892`, plus a Settings control and i18n keys in all locales.
≈ 60-100 lines + 2 tests + i18n. Depends on nothing; the enum members come from
`generated/Personality.ts`. Open question for the owner: whether a personality is a Nessy-wide
concept (Pi and Claude would need their own expression of it) or a codex-only passthrough — the
share-vs-split rule applies and a split needs a measured native mechanism on each runtime, which
I have not measured for Pi/Claude.

CITATION: `learn.chatgpt.com/docs/personalize.md#choose-a-personality` — "Choose **Friendly**, **Pragmatic**, or **None**
as the default personality in **Settings > Personalization**."

---

## Lane summary of NOT-MEASURED items

- Row 85: the pinned codex binary's / schema's `ReasoningEffort` enum members — needed to decide
  whether `xhigh`→`high` is a gap or a faithful narrowing. (Also: what Max/Ultra are on the wire.)
- Row 91: whether Pi and Claude have a native personality mechanism — needed before choosing
  share-vs-split for a personality setting.
- Nothing else in this lane was left unmeasured.

---

# LANE E — P5.2 re-triage at HEAD

Repo HEAD at audit time: **e6f9208f14a9ddeea8fea901fd1b5e77bf33623b** (the brief's audited SHA
`f58f66a36` is 3 commits behind: `097e70596`, `b1824c4b4`, `e6f9208f1` — none touch the codex
sandbox/permissions path, so no row below is affected by the drift).

Rows: 95, 96, 98, 100, 101, 110, 113, 115, 116, 117, 118.

Global probe controls used on every absence claim (one run, HEAD, `probe.sh` over
`packages/ apps/ scripts/`, excluding node_modules/.references/release/resources/generated/dist):

```
additionalDirectories      files=18     sandbox_mode               files=6    <- positive controls
CODEX_HOME                 files=27     AGENTS.md                  files=139
xhigh                      files=43     approvals_reviewer         files=5
--- the zeros -------------------------------------------------------------------
additional_directories     files=0      writable_roots             files=0
sandbox_workspace_write    files=0      allowed_permission_profiles files=0
allowed_sandbox_modes      files=0      codex://                   files=0
deep_scan                  files=0      codex-security/config      files=0
codex-security             files=0      SECURITY.md                files=0
primary folder             files=0
--- the small non-zeros ---------------------------------------------------------
default_permissions        files=3      NESSY_RUNTIME_PERMISSION_PROFILE files=1
openai-curated             files=3 (ALL THREE ARE TESTS)   permissions.nessy_runtime files=3
```

**Counts above are MENTION counts and two of them lie.** Both were caught by reading the call site
instead of the number, and both changed a verdict:
- `additionalDirectories files=18` reads as "present" and is, on the host gate — but the one codex
  call site omits the argument (row 95, layer 2).
- `xhigh files=43` reads as "supported" and is, as a UI level — but the codex projection table
  collapses it to `high` (cluster substrate note, priced on row 117).

Every absence claim below is paired with a positive control on the same run, and every presence
claim points at the line that uses the name, not at a count.

---

## SEVERE — read this before the rows

Row 101 turns up a **security-relevant correctness bug**, and it is the same missing key that
row 95 turns up as a feature gap. Stated once here, priced in row 101:

`config-writer.ts:954` writes `sandbox_mode` **unconditionally**, and `:955-956` writes
`default_permissions = "nessy_runtime"` alongside it whenever a filesystem policy exists.
`permissions.md` (sibling page, orchestrator-confirmed) says those two do not compose and
`sandbox_mode` wins. The only filesystem entry we express through the losing key is the **deny on
the host's encrypted credential store** — `deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')]`
(`codex-agent.ts:1254, 1400, 2386`) — plus the plugin `runtime.dataPath` write grants. Both are
inert. And `validateConfigAgainstSchema` (`config-writer.ts:1085-1087`) *requires* the two keys to
appear together, so our own validator asserts the forbidden combination as an invariant.

The legacy key that WOULD work is the one `sandboxing.md` names — `sandbox_workspace_write.writable_roots`
— and we write it zero times. But it cannot carry the deny: the bundled release schema's
`SandboxWorkspaceWrite` has exactly four properties (`writable_roots`, `network_access`,
`exclude_slash_tmp`, `exclude_tmpdir_env_var`) and **no deny form at all**. So the two halves of our
filesystem policy need two different fixes, and one of them has no legacy expression.

---

## Row 95 — `projects` (map: 🟨)

**HEAD-STATUS:** `map STALE: the gap is TWO layers deep, not one. The map found the config layer;
the host-gate layer drops it too.`

*(This row was re-done at use level, not mention level, after Lane A's correction that a grep hit
is a mention and not a use. Reading the call sites rather than the counts is what turned up the
second layer.)*

**Layer 1 — the codex config (map's claim, re-probed, holds).** `additionalDirectories` hits
**18 files repo-wide** (the map measured 2), and none is on the codex path: 0 hits across
`packages/shared/src/agent/codex-agent.ts`, `packages/codex-responses-adapter/src`,
`packages/codex-agent-server/src`; `additional_directories` = 0 repo-wide. Rather than rest on a
zero, here is the positive read — the codex config is built at exactly three sites, and their
complete path-option lists are:

| site | filesystem options passed |
| --- | --- |
| `codex-agent.ts:1254` (`buildCodexConfigToml`, initial spawn) | `deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')]` — and nothing else |
| `codex-agent.ts:1400` (`buildCodexRuntimeConfigOverride`, signature baseline) | same single deny |
| `codex-agent.ts:2386` (`applySelectedPluginSkillRuntimePolicy`) | same deny + `writablePaths: pluginRuntime.writablePaths` |

and `pluginRuntime.writablePaths` has exactly one producer — `writablePaths.add(runtime.dataPath)`
at `codex-agent.ts:2330`. There is no directory source on the codex config path other than a
hardcoded credential deny and plugin data dirs.

**Layer 2 — the host gate, which the map did not check and which I initially got wrong.** I first
wrote that the shipped `SANDBOX_ENABLED_DEFAULT = false`
(`packages/shared/src/config/sandbox-settings.ts:353`) makes this benign, because
`danger-full-access` leaves the host PolicyEngine as the only gate and *that* honours
`additionalDirectories`. Reading the call site refutes it: the **only** `shouldAllowToolInMode` call
on the codex path is `codex-agent.ts:2232`, and its options object is
`{ permissionsContext: permissionContext }` — **`additionalDirectories` is not passed.** Compare
the host's own gate, where it genuinely is threaded (real call arguments, not mentions):
`SessionManager.ts:6029, 6356, 6539`, each `{ permissionsContext, additionalDirectories:
this.sessionAdditionalDirectories(managed) }`.

Direction of the resulting error, checked in `mode-manager.ts` rather than assumed:
`additionalDirectories` is a **widening** option — `findContainingAdditionalDirectory(targetPath,
additionalDirectories)` at `:2524` (and again at `:2623`) turns an otherwise-blocked write into
`{ allowed: true }`, and `:2544-2552` lists the directories in the refusal message. So dropping it
makes codex **stricter than Pi**, not looser: this is a functionality/parity gap, not a security
hole. A user who attaches a second folder gets writes to it on Pi and a "target not in allowed
folders" refusal on codex — and the refusal message will not even list the directory, because the
list it prints comes from the argument that was never passed.

So the page's contract fails twice over, in the same direction, at two independent layers.

"Primary folder" as a concept: `primary folder` = 0 files. Not expressed; secondary-vs-primary
discovery semantics for `AGENTS.md`/skills/`config.toml` have no counterpart here.

- **VERDICT:** take the contract
- **KIND:** bug for layer 2 (built, and built with an argument silently omitted at one of two
  sibling call sites) / forgotten vs doc-parity for layer 1
- **COST:** two fixes, and the cheap one is the one that matters most today.
  - **Layer 2 — ~3 lines, do this first.** Pass `additionalDirectories` at
    `codex-agent.ts:2232`. The source is already reachable the same way Pi reaches it
    (`resolveAdditionalDirectories` in `packages/shared/src/agent/additional-directories.ts`, whose
    `loadStoredConfig()?.additionalDirectories` fallback at `:79` needs no session plumbing).
    Tests: 1 positive (write into an attached dir is allowed on codex), 1 negative (write outside
    both is still refused, and the message now lists the dirs). This restores Pi parity under the
    shipped sandbox-off default, which is where users are today.
  - **Layer 1 — one config key.** `[sandbox_workspace_write] writable_roots = [...]` in
    `config-writer.ts` gated on `sandboxMode === 'workspace-write'` (~10 lines), threading the
    session's `sessionAdditionalDirectories(managed)` (`SessionManager.ts:3690, 22009`) into
    `CodexConfigOptions` (~15 lines across 2 files) + `requiredKeys` in
    `validateConfigAgainstSchema`. Only bites when an operator turns the sandbox master switch back
    on. **Blocked on row 101's decision** — if we instead drop `sandbox_mode` and commit to
    permission profiles, these become `[permissions.nessy_runtime.filesystem]` write entries and
    the diff shrinks to ~3 lines. Same missing key as row 101; do not build both.
- **CITATION:** `learn.chatgpt.com/docs/projects.md#use-local-projects-for-folders-and-codebases` — "Select **Add folder**
  to attach multiple folders. ChatGPT can read and change files in every attached folder."
- **TAG:** `[doc:codex]`
- **NOT-MEASURED:** whether the layer-2 omission is reachable in every permission mode or only in
  the write-restricted branches (`explore`/`plan`) where `findContainingAdditionalDirectory` is
  consulted. I read the two call sites in `mode-manager.ts` but did not enumerate which modes reach
  them, so "codex refuses what Pi allows" is proven for the restricted-write branches and asserted,
  not proven, in general. Also unproven live: no codex turn was executed against an attached
  second folder.

## Row 96 — `prompting` (map: 🟨)

**HEAD-STATUS:** `map still correct`, and the map's own open item is now **measured**: the answer
is one built gap and one deliberate divergence.

The map left "editing/reordering the queue above the composer was not checked against the page".
Checked. `apps/electron/src/renderer/components/app-shell/input/QueuedMessageList.tsx` (96 lines) is
the queue strip above the composer. Against the page's four verbs:

| page verb | HEAD |
| --- | --- |
| edit | built — `onEdit(id, text)`, i18n `chat.queue.edit` = "Edit message" |
| send | built — `onSteer(id)`, `chat.queue.steer` = "Steer" / "Submit without interrupting the model" |
| delete | built — `onDelete(id)`, `chat.queue.delete` = "Delete queued message" |
| **reorder** | **not built**, and known: `QueuedMessageList.tsx:18` reads `// ponytail: reorder + dnd when queues get deep` |

Steer/queue wire side re-confirmed at HEAD: `SubmitMode = 'send' \| 'queue' \| 'steer' \| 'stop'`
and `queueSupported` (`submit-control.ts:26, 33-34, 64`), `turn/steer` present in 8 files.

One divergence the map did not name: the page puts the default under a **global**
"Settings > General > Follow-up behavior". Ours is **per-connection** —
`LlmConnection.midStreamBehavior` (`packages/shared/src/config/llm-connections.ts:244, 668-671`,
written by `createBuiltInConnection`, persisted at `storage.ts:2771`), surfaced as
`settings.ai.midStream.{steer,queue,title}`. That is a defensible product choice (steer support is
a per-runtime capability — `queueSupported` exists precisely because runtimes differ), so it is a
divergence to record, not a bug. The page's "shortcut for using the other behavior for one message"
maps to our per-message Steer button rather than a keybinding; no keyboard one-off was found.

- **VERDICT:** take the contract (reorder only) / record the divergence as deliberate (global vs
  per-connection default)
- **KIND:** forgotten vs doc-parity
- **COST:** reorder is one component + one wire field. `QueuedMessageList.tsx` (+~40 lines for
  up/down buttons; dnd is larger), a `queue/reorder` or reordered-array RPC on the session
  (`QueuedMessageDto` lives in `packages/shared/src/protocol/dto.ts`), plus whatever owns queue
  order server-side (`queuedMessages` = 3 files: `dto.ts`,
  `renderer/event-processor/types.ts`, `handlers/__tests__/handle-interrupted.test.ts` — the
  authoritative store was NOT located, see NOT-MEASURED). 2 tests (reorder persists across a turn
  boundary; reorder of a 1-element queue is a no-op).
- **CITATION:** `learn.chatgpt.com/docs/prompting.md#steering-and-queuing` — "Queued messages appear above the composer,
  where you can edit, reorder, send, or delete them."
- **TAG:** `[doc:codex]`
- **NOT-MEASURED:** which module owns the authoritative queue ORDER server-side. `queuedMessages`
  resolves to a DTO and a renderer type; I did not trace the SessionManager field that holds the
  array, so the "+1 file" in the cost is an estimate, not a count.

## Row 98 — `reference/troubleshooting` (map: 🟥)

**HEAD-STATUS:** `map STALE: every line number in the cell is dead; every fact it asserts is true.`

The cell's three code cites all moved: `mkdtempSync(join(tmpdir(), 'nessy-codex-home-'))` is now
`codex-agent.ts:1204` (cell said `:447`), `rmSync(..., {recursive, force})` is `:3717` (cell said
`:1928-1930`), and the "mismatch aborts" cite `runtime-manager.ts:28` now lands inside a
`PROXY_ENV_VARS` comment block added 2026-08-27. The manifest gate itself is intact:
`verifyCodexBinary(opts.binaryPath, opts.platformDir)` at `runtime-manager.ts:128`, throwing
`CodexIntegrityError` from `manifest-verifier.ts:288, 302, 342`. `ShikiDiffViewer.tsx` still
exists. The "permission-mode change tears the home down" path is live:
`ensureRuntime()` → `teardownRuntime()` on `pendingModeRestart` (`codex-agent.ts:1183-1188`).

The verdict itself survives re-probe. The page's diagnostic paths are `$CODEX_HOME/sessions` and
`$CODEX_HOME/archived_sessions`; our `CODEX_HOME` is a per-runtime `mkdtemp` at 0700 that no
session outlives, so a transcript can never be there to find. The rest of the page (sidebar
project removal, "Chronological" filter, archived-chat settings, `.worktreeinclude`, `/` feedback,
"Code font") is ChatGPT-desktop UI.

- **VERDICT:** not our surface — the page is a FAQ about the ChatGPT desktop app's own UI and about
  a durable `~/.codex` that our architecture deliberately does not have. Its one host-shaped
  suggestion (compare CLI and app versions) is superseded by a stricter mechanism we already ship
  (manifest hash verification that aborts the spawn).
- **KIND:** never looked at (nothing here was ever a candidate; recording it so it stops being
  re-triaged)
- **COST:** zero. Nothing to build. The only cost is the stale line numbers in the map cell.
- **CITATION:** `learn.chatgpt.com/docs/reference/troubleshooting.md#feedback-and-logs` — "- Session transcripts:
  `$CODEX_HOME/sessions` (default: `~/.codex/sessions`)"
- **TAG:** `[doc:codex]`

## Row 100 — `remote-connections` (map: 🟥)

**HEAD-STATUS:** `map still correct` — both absences re-probed at HEAD with live positive controls.

`ssh` (case-insensitive) in `packages/codex-agent-server/src/` = **0 files**; positive control
`stdio` on the same tree = **5 files**. Repo-wide `ssh` hits are all unrelated (renderer keyboard
helpers, iOS transport, generated protocol bindings) — no SSH transport, no `~/.ssh/config` reader,
no remote-project concept. `handoff` repo-wide is `quit-finalizer.ts`, renderer session atoms and
marketplace strip — no cross-host chat handoff.

So the page's one genuinely host-directed rule — don't expose the app-server transport on a shared
network — we satisfy **structurally rather than by policy**: `runtime-manager.ts` spawns the
bundled binary with no transport argument (stdio default) and `app-server-client.ts` is a JSON-RPC
client over that subprocess's stdin/stdout. There is no listener to expose. The page's remaining
contract (start the remote app-server over SSH with the remote user's login shell; remote projects
support one folder; handoff moves a chat and its git state to a worktree on another host) describes
a product we do not have.

Worth naming because it is the one thing here that could become ours: the same page's rule is what
a future "remote Nessy server" would have to honour, and `apps/cli` already speaks websocket to a
headless server. Nothing in `docs/` records this as a decision — the map measured that and it still
holds.

- **VERDICT:** record the divergence as deliberate — but the deviation is currently UNRECORDED, and
  that is the actionable half. We comply with the security rule by construction; we simply do not
  offer remote hosts.
- **KIND:** never looked at
- **COST:** the divergence record is ~5 lines in
  `docs/superpowers/specs/2026-07-29-deviation-register.md`'s source (the register is GENERATED —
  `python3 scripts/regenerate-deviation-register.py`, so the category string goes in the code/plan
  comment it harvests from, not the file). Building remote SSH projects is a product decision, not
  a doc-parity item; cost unknown and deliberately not estimated.
- **CITATION:** `learn.chatgpt.com/docs/remote-connections.md#authentication-and-network-exposure` — "Remote connections
  use SSH to start and manage the remote Codex app server. Don't expose app-server transports
  directly on a shared or public network."
- **TAG:** `[doc:codex]`

## Row 101 — `sandboxing` (map: 🟨)

> **SEVERE.** Our filesystem policy — including the `deny` protecting the host's encrypted
> credential store from the codex subprocess — is written through a key that codex ignores whenever
> `sandbox_mode` is also present, and we write `sandbox_mode` unconditionally.

**HEAD-STATUS:** `map WRONG` — the cell's central reassurance is inverted by measurement.

The cell says, in its own words, that writable roots are "expressed in the MODERN form, not the
legacy key": `writable_roots` → 0, but `config-writer.ts` builds `default_permissions` +
`permissions.<profile>.extends` + `filesystem`, "the same vocabulary auto-review mentions." That
reading is wrong, and the page that proves it is the sibling `permissions.md`:

> "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config
> profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of
> `default_permissions`." — `permissions.md` (page intro, before the first heading; nearest
> normative section is `#migrate-from-older-sandbox-settings`, which restates it: "Use one system or
> the other for a session, not both.")

**What HEAD actually emits** (`buildCodexConfigToml`, `packages/codex-responses-adapter/src/config-writer.ts`):

- `:954` `sandbox_mode = "<mode>"` — **unconditional**, every config, every mode.
- `:955-956` `default_permissions = "nessy_runtime"` — emitted whenever `hasFilesystemPolicy`.
- `:1002-1013` `[permissions.nessy_runtime]` + `.extends` + `[permissions.nessy_runtime.filesystem]`.
- `:1085-1087` `validateConfigAgainstSchema` **requires** `default_permissions` and `permissions` to
  be present *in addition to* the always-required `sandbox_mode`. Our own validator pins the
  forbidden pairing as an invariant.

**What is lost when the losing key loses** (`resolveRuntimePolicy`, `:800-813`) — the `filesystem`
map has exactly two producers:
1. `writablePaths` → plugin skill `runtime.dataPath` (`codex-agent.ts:2330`). Write grants.
2. `deniedReadPaths` → `[join(CONFIG_DIR, 'credentials.enc')]`, hardcoded at three call sites
   (`codex-agent.ts:1254, 1400, 2386`). **This is a credential-exfiltration control.**

Neither takes effect. And `allowed_permission_profiles` — the one documented exception that makes
codex honour permission profiles anyway — is **0 files** repo-wide; `allowed_sandbox_modes` is 0 too.
The bundled binary is not the blocker: `packages/codex-protocol/manifest.json` pins
`openai/codex rust-v0.148.0` (permissions.md's floor is 0.138.0) and the release
`config-schema.json` carries `default_permissions`, `permissions`, `sandbox_workspace_write` and
`approvals_reviewer` as top-level properties.

**Severity, honestly bounded.** The shipped default is `SANDBOX_ENABLED_DEFAULT = false`
(`sandbox-settings.ts:353`), so today every codex mode but `dontAsk` already gets
`danger-full-access` — the deny was never enforced in the default configuration, and *that* is a
recorded, owner-approved deviation (`sandbox-default-off-until-agent-stabilization`,
`codex-danger-full-access-when-sandbox-off`). The new fact is that **turning the sandbox back on
does not restore the deny either** — the operator gets `workspace-write`, believes
`credentials.enc` is denied and the plugin data dir is granted, and neither is true. A control that
fails in the position where it is supposed to work is worse than one that is documented off.

**What sandboxing.md itself contributes.** The page never mentions `default_permissions` (grep:
0 occurrences). It names the legacy vocabulary as *the* vocabulary — "the [Configuration reference]
documents the exact keys for `sandbox_mode`, `approval_policy`, `approvals_reviewer`, and
`sandbox_workspace_write.writable_roots`" — and prescribes writable roots for the multi-directory
case. So the two pages disagree about which system is current (permissions.md is flagged "Beta"),
and our config picks a third option: emit both, get neither.

Everything else in the cell re-probes true at HEAD: `CodexSandboxMode`/`CodexApprovalPolicy` types,
the seven-mode table with its two in-comment deviation strings, `approvals_reviewer` now present in
5 files, `sandbox_workspace_write` and `writable_roots` both still 0.

- **VERDICT:** take the contract
- **KIND:** bug (built, built wrong)
- **COST:** the decision is bigger than the diff. Two coherent options, both in one file:
  - **(a) Legacy, complete.** Emit `[sandbox_workspace_write] writable_roots = [...]` and STOP
    emitting `default_permissions`/`[permissions.*]`. ~25 lines in `config-writer.ts` +
    `validateConfigAgainstSchema` key list. **But this cannot express the deny**: the schema's
    `SandboxWorkspaceWrite` definition has only `writable_roots`, `network_access`,
    `exclude_slash_tmp`, `exclude_tmpdir_env_var` — no deny form. The credential protection would
    have to move entirely to the host PolicyEngine and be documented as such.
  - **(b) Profiles, complete.** Stop emitting `sandbox_mode`; write a `requirements.toml` into the
    ephemeral CODEX_HOME carrying `allowed_permission_profiles`. ~40 lines: a new writer beside
    `codex-config-requirements.ts` (which today only READS via `configRequirements/read`), the
    `sandbox_mode` removal, and the `approval_policy`/mode table rewritten against profile names.
  - Either way: `config-writer.test.ts` and `sandbox-regression.test.ts` both need rewriting —
    `sandbox-regression.test.ts` is explicitly marked "SECURITY PATH — do not simplify away these
    assertions" and asserts on `sandbox_mode` values, so option (b) invalidates its whole premise.
    Minimum new tests: 1 that the emitted TOML never contains both keys, 1 that the
    `credentials.enc` deny is expressed through whichever key is authoritative.
  - **Blocker before either:** whether the bundled `codex-app-server` reads a `requirements.toml`
    from `$CODEX_HOME` (rather than only from a deployment path) is unmeasured — see NOT-MEASURED.
- **CITATION:** `learn.chatgpt.com/docs/sandboxing.md#configure-defaults` — "If you need the agent to work across more
  than one directory, writable roots let you extend the places it can modify without removing the
  sandbox entirely."
- **TAG:** `[doc:codex]` — governed by two codex pages, `sandboxing.md` and `permissions.md`, which
  disagree with each other; `permissions.md` is the one that states the precedence rule.
- **NOT-MEASURED:** (1) whether codex 0.148.0 reads `requirements.toml` from `$CODEX_HOME` — the
  binary was not probed (the technique exists in-tree: `codex-config-requirements.ts` documents a
  string-probe of `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` with positive
  and negative controls). Option (b) is unpriceable until that probe runs. (2) Live confirmation
  that the deny is actually ignored — this is a doc-derived conclusion plus a code reading, not an
  executed codex turn.

---

## The `security/plugin/*` cluster (110, 113, 115, 116, 117, 118)

These six are one page-family about a third-party plugin, `codex-security`, installed from the
`openai-curated` marketplace. Five of the six describe **prompt workflows executed inside that
plugin** and put no obligation on our host. One — row 118 — puts a real obligation on the host, and
we fail it. Answering the differing question per row, not six variations of one answer.

Shared substrate, re-probed once at HEAD and referenced by all six:
- `codex-security` as a literal = **0 files** in `packages/ apps/ scripts/`. We have never
  hardcoded anything about this plugin — correct, it is user-installed content.
- `openai-curated` = **3 files, all tests**
  (`marketplace/__tests__/external-catalog-adapters.test.ts`,
  `marketplace/__tests__/registry-catalog-items.test.ts`,
  `plugins/__tests__/registry-catalog-fetcher.test.ts`). It is modelled, not bundled: no production
  code names it, so it is a registry a user adds, and `MarketplaceService.install`
  (`packages/shared/src/marketplace/service.ts:181`) is generic over the source.
- Live evidence the plugin actually works here is unchanged and still on disk:
  `docs/superpowers/plans/2026-07-29-codex-adapter-spec.md:245` (adapter run over the real
  `codex-security` bundle) and `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:1718`
  (32 MCP tools from the packaged build).
- **`xhigh` = 43 files, and that count is a trap — I fell into it before reading the call site.**
  Four of the five pages recommend "`xhigh` reasoning effort". `xhigh` really is in our vocabulary
  (`CodexThinkingLevel` includes it, `config-writer.ts:231`), so a mention count says "satisfied".
  The **use** says otherwise: `CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'`
  (`:232`) has no `xhigh`, and the projection table at `:236-243` maps **`xhigh: 'high'` and
  `max: 'high'`**. A user who selects xhigh gets `model_reasoning_effort = "high"` written into
  codex's config. The cap is ours, not codex's: the bundled release schema's `ReasoningEffort` is
  an open string ("A non-empty reasoning effort value advertised by the model", `minLength: 1`) —
  not an enum — so `validateConfigAgainstSchema`'s enum check at `:1178` is a no-op for it and
  `xhigh` would pass through untouched. Bounded honestly: the pages pair xhigh with `gpt-5.6-sol`,
  a model the Nestor gateway does not serve, so no one can follow the recommendation literally here
  anyway. But the silent two-step downgrade (`xhigh` → `high`, `max` → `high`) applies to every
  model on the codex runtime and is recorded nowhere. Carried as a finding on row 117.

### Row 110 — `security/plugin` (map: 🟨)

**HEAD-STATUS:** `map STALE (minor) + one host contract the map did not measure.`

Stale: `openai-curated` is now 3 test files, not 1. New and not in the map: the page offers a
one-click install through a **custom URL scheme** — `codex://plugins/install/codex-security?marketplace=openai-curated`.
`codex://` = **0 files**. We register exactly one scheme, `nessy://`
(`apps/electron/src/main/index.ts:181, 244, 248`, `DEEPLINK_SCHEME`), and our deep-link vocabulary
has **no install action at all** — `apps/electron/src/renderer/contexts/deep-link-policy.ts`
enumerates `action/...` verbs and blocks the mutating ones for external origins by design: "A link
Nessy did not produce is inert: it may choose a directory and fill the prompt box, and nothing
reaches the model until the user reads the prefill and presses Enter."

That is not a gap — it is a deliberately stricter posture than the page's one-click install button,
already reasoned in-tree. Recording it so it is not re-discovered as a missing feature.

The CLI half of the page (`/plugins` → search → Install plugin) is genuinely reproduced by our
PluginsPage + marketplace install path. The app half (the native **Security** sidebar workbench) is
a ChatGPT-desktop surface we do not have and the rest of the cluster keeps pointing at.

- **VERDICT:** record the divergence as deliberate (the `codex://` one-click install; ours is
  inert-by-policy) — the install path itself is already taken
- **KIND:** never looked at (the deep-link half; the install half is built)
- **COST:** zero to keep. Adding a `codex://`-equivalent install deep link would mean a new
  scheme registration + a new `action` verb + a confirmation gate, and would directly contradict
  `deep-link-policy.ts`'s stated contract — do not do it without an owner decision.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin.md#install-the-plugin` — "Enter `/plugins`, search for **Codex
  Security**, and select **Install plugin**."
- **TAG:** `[doc:codex]`

### Row 113 — `security/plugin/fix-findings` (map: 🟨)

The differing question: *does this page put anything on the host?* Its host-shaped content is
entirely about `codex exec` on a CI runner — "Install Codex Security in the `CODEX_HOME` that
`codex exec` uses"; `--sandbox workspace-write`; "A fresh CI runner doesn't include marketplace
plugins by default." We do not ship `codex exec`; we spawn `codex-app-server` over JSON-RPC
(`runtime-manager.ts`, `app-server-client.ts`) and install plugins through our own marketplace
service. The interactive half (the **Patch** tab in the Security workbench) is the app surface we
do not have. What remains is one chat message invoking a skill of an installed plugin — which our
host already delivers, proven live.

**HEAD-STATUS:** `map still correct`.

- **VERDICT:** not our surface — every obligation on the page lands on either the plugin
  (`$codex-security:fix-finding`) or the `codex exec` CLI, and we ship neither. The one thing that
  *is* ours (a chat turn reaching a plugin skill) is built and live-proven.
- **KIND:** never looked at
- **COST:** zero. The map's remaining honest note stands: nobody has run this workflow end-to-end
  in our host. That is a live-checklist case, not code — one row in
  `docs/testing/cdp-live-checklist.md` + a narrative.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin/fix-findings.md#fix-a-finding-from-the-cli` — "Install Codex
  Security in the `CODEX_HOME` that `codex exec` uses before you run these commands."
- **TAG:** `[doc:codex]`

### Row 115 — `security/plugin/security-hardening` (map: 🟨)

The differing question, answered by grep: this is the **only page in the cluster with zero
host-shaped tokens**. Searched for `CODEX_HOME`, `config.toml`, `codex exec`, `codex plugin`,
`SECURITY.md`, `.codex`, `sandbox`, `approval`, `network` — **not one hit on the whole page**. It
is 66 lines: what evidence to hand the workflow, the prompt, and how to read the resulting
`hardening/hardening.md` + `hardening.json`. Both artifacts are written by the plugin into the
scan directory; nothing about their location or lifetime is ours.

**HEAD-STATUS:** `map still correct`.

- **VERDICT:** not our surface — the page is a prompt-authoring guide for a skill inside an
  installed plugin. There is no host key, no path, no config, no CLI. Our only role is that the
  plugin's skills reach the codex runtime, which is already measured (MCP-W2,
  `docs/testing/cdp-live-checklist.md` row MCP-W2, PASS 22/25 2026-08-21).
- **KIND:** never looked at
- **COST:** zero.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin/security-hardening.md#prepare-the-evidence` — "The workflow uses
  the evidence to identify repeated broken invariants, dispersed controls, privileged choke points,
  weak isolation boundaries, and recurring remediation patterns."
- **TAG:** `[doc:codex]`

### Row 116 — `security/plugin/code-changes` (map: 🟨)

The differing question: this is the **most host-shaped page of the five non-118 pages**, and every
one of those hooks is CI, not desktop. It carries four full CI recipes (GitHub, GitLab, Azure,
Jenkins) that each `export CODEX_HOME=<runner temp>`, `npm install --global @openai/codex`,
`codex plugin add codex-security@openai-curated`, and `codex exec --sandbox workspace-write`. Not
one of those four verbs exists here: we do not install the npm CLI, we have no `codex plugin`
subcommand (marketplace service instead), and `codex exec` has no counterpart.

One thing worth stating because it looks like a match and is not: the recipes set `CODEX_API_KEY`
from a scan credential. We do define a `CODEX_API_KEY_ENV` (`config-writer.ts`, provider
`env_key`), but ours addresses the loopback Nessy-gateway adapter, not a plugin scan credential —
different key, different consumer. No contract taken or missed.

The `findings.json` schema this page links is already cited in-tree, from GitHub rather than from
here (`docs/superpowers/plans/2026-07-29-codex-adapter-spec.md:147`).

**HEAD-STATUS:** `map still correct`.

- **VERDICT:** not our surface — the page's host obligations are all `codex exec` / `codex plugin`
  CLI on a CI runner. The half that is ours (a chat turn saying
  `Use $codex-security:security-diff-scan ...`) needs no host change.
- **KIND:** never looked at
- **COST:** zero.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin/code-changes.md#automate-reviews-in-cicd` — "Continue with this
  section to invoke the installed plugin skill through `codex exec`."
- **TAG:** `[doc:codex]`

### Row 117 — `security/plugin/scans` (map: 🟨)

The differing question: the page names two repository files, and the distinction between them is
the whole answer. `SECURITY.md` is read **by the plugin**, explicitly as data — "Codex Security
treats these files as policy context, not executable instructions" — so its absence here
(`SECURITY.md` = **0 files** repo-wide; positive control `AGENTS.md` = 139 files) is a fact about
*this repository as a scan target*, not a host gap. The map reached the same conclusion and it
survives re-probe. `AGENTS.md` the page also names, and we have 139 of them.

The one thing that IS a host obligation is the step the map treated as scenery: "For the best scan
quality, use `gpt-5.6-sol` with `xhigh` reasoning effort", and step 4 "Choose a model and reasoning
effort." **We silently cannot deliver the effort half.** See the cluster substrate note above:
`config-writer.ts:236-243` maps `xhigh → 'high'` and `max → 'high'`, because
`CodexReasoningEffort` (`:232`) tops out at `high`, while the bundled codex schema's
`ReasoningEffort` is an open string and would accept `xhigh` verbatim. This is not specific to
security scans — it is every codex turn — but this page is where the coverage map first touches it.

**HEAD-STATUS:** `map STALE: "🟨 because the plugin reads SECURITY.md" is right; the effort
downgrade under the same page is a host defect the cell does not mention.`

- **VERDICT:** take the contract — one verdict, and it is this one rather than `not our surface`
  because the page's step 4 ("Choose a model and reasoning effort") IS a host obligation and we
  fail it. The scan workflow around it is not our surface (the **Scans** workbench is an app
  surface we lack; `SECURITY.md` is read by the plugin as data), but a page with one live host
  obligation is a contract to take, not a surface to disclaim.
- **KIND:** bug (built, built wrong) — the effort downgrade. The rest of the page: never looked at.
- **COST:** small and self-contained, but needs one answer first. `config-writer.ts:232` widen
  `CodexReasoningEffort` to include `xhigh` (and decide what `max` becomes), `:236-243` make the
  two rows identity. ~4 lines + `config-writer.test.ts` cases. **The answer needed:** whether the
  gateway models actually advertise an `xhigh` effort — the schema accepts any advertised string,
  so writing an unadvertised one may be rejected at `initialize` rather than ignored. Probe the
  models endpoint before widening; a blind widen risks turning a silent downgrade into a spawn
  failure. Separately and not a parity item: this repo has no `SECURITY.md`, which only matters the
  day someone scans *it*.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin/scans.md#configure-the-scan` — "For the best scan quality, use
  `gpt-5.6-sol` with `xhigh` reasoning effort."
- **TAG:** `[doc:codex]`
- **NOT-MEASURED:** whether any model reachable through the Nestor gateway advertises `xhigh`. Not
  probed — that needs a live `…/api/v1/cli/models` call, which is out of scope for a read-only
  lane. Until it runs, the fix is unpriceable beyond the 4 lines.

### Row 118 — `security/plugin/deep-scans` (map: 🟥) — the one host obligation in the cluster

**HEAD-STATUS:** `map STALE: the line numbers are dead, the finding is confirmed and now stronger.`

The page: "To control a deep scan's concurrency and duration, create or edit
`~/.codex/codex-security/config.toml`. If you set `CODEX_HOME`, use
`$CODEX_HOME/codex-security/config.toml` instead." Six settings under `[deep_scan]` (`workers`
default 4, `subagents` default 3, `stop_after_no_new`, `stop_after_consecutive_errors`,
`max_discovery_runs`, `max_time_hours` default 96). This is the only page in the cluster whose
configuration surface is addressed by `CODEX_HOME` — i.e. by a variable **we** own.

Re-verified at HEAD, with the map's stale cites corrected:
- We set `CODEX_HOME` and it is ephemeral: `mkdtempSync(join(tmpdir(), 'nessy-codex-home-'))` at
  **`packages/shared/src/agent/codex-agent.ts:1204`** (map said `:447`), `chmodSync(..., 0o700)` at
  `:1205`.
- It is destroyed on every teardown path: `rmSync(codexHome, { recursive: true, force: true,
  maxRetries: 5, retryDelay: 50 })` at **`:3717`** (map said `:1930`), inside
  `cleanupRuntimeResources`, reached from `teardownRuntime` (`:3765`), from the `createRuntime`
  failure rollback (`:1404`), and from `destroy` (`:3791`).
- A permission-mode change destroys and rebuilds it: `ensureRuntime()` checks `pendingModeRestart`
  and calls `teardownRuntime()` before respawning (`:1183-1188`); the invariant is written down at
  `packages/codex-responses-adapter/src/config-writer.ts:512` and `:525` — "A permission-mode change
  tears the whole home down and rebuilds it."
- `deep_scan` = 0 files, `codex-security/config` = 0 files. Nothing writes or preserves it, and the
  deviation is still unrecorded.

**Consequence, stated plainly.** A user who follows this page inside Nessy Desktop has nowhere to
put the file. `~/.codex/codex-security/config.toml` is not read because `CODEX_HOME` is set;
`$CODEX_HOME/codex-security/config.toml` is deleted before the next session and again on the next
permission-mode flip. So deep-scan tuning is *unreachable by construction* — the user always gets
the defaults, and the page's own advice ("Lower values can reduce scan time and token use") is
inoperable. This is not the plugin's problem to solve; the path is `$CODEX_HOME`-relative precisely
so the host can own it.

**The second risk, and it is a real one.** Defaults are `workers = 4` × `subagents = 3` = up to
twelve concurrent codex scan processes, each with its own file descriptors, inside an Electron main
process whose fd ceiling does **not** inherit the shell's `ulimit -n` (floor 256 here — AGENTS.md's
"Traps" section records this costing a real measurement, where fd-hungry paths fail in the app
while every shell probe succeeds). The one knob that would bound it is the file we make
unwritable. `max_time_hours` defaults to 96 — four days — against a runtime whose home is deleted
when the user changes permission mode, so a long deep scan is also silently destructible.

This page also carries the cluster's `xhigh` recommendation ("For the best scan quality, use
`gpt-5.6-sol` with `xhigh` reasoning effort", `#confirm-setup-and-preflight`) and adds "Deep scan
workers inherit your selected model and reasoning settings" — so the `xhigh → high` downgrade
recorded on row 117 propagates to every worker of a deep scan, not just the parent turn. Same
defect, one fix; priced on row 117.

- **VERDICT:** take the contract
- **KIND:** forgotten vs doc-parity (the ephemeral-home design is deliberate and good; nobody asked
  what a plugin's own `$CODEX_HOME`-relative config does under it)
- **COST:** small, and it generalizes. The shape is a **durable plugin-config overlay projected
  into the ephemeral home on every build** — exactly the pattern `CODEX_AGENT_ROLE_DIR` and
  `CODEX_RULES_DIR` already use (`config-writer.ts:516, 529`: "re-derived from the durable store on
  every build"). Concretely: a durable store under our config dir, plus a projector alongside
  `writeCodexRulesFile` that copies `<store>/<plugin>/…` into `$CODEX_HOME/<plugin>/…` after
  `mkdtemp` (~40-60 lines in `config-writer.ts` + `codex-agent.ts:createRuntime`), plus a UI or
  settings key to author the values. Tests: 1 positive (file lands in the fresh home after a
  permission-mode restart), 1 negative (no store → no directory created, byte-identical home).
  Depends on nothing else in this lane. If the fd risk is confirmed, add a clamp on `workers` ×
  `subagents` when projecting — that is the argument for owning the file rather than
  documenting a workaround.
- **CITATION:** `learn.chatgpt.com/docs/security/plugin/deep-scans.md#configure-deep-scan-runtime` — "If you set
  `CODEX_HOME`, use `$CODEX_HOME/codex-security/config.toml` instead."
- **TAG:** `[doc:codex]`
- **NOT-MEASURED:** the fd exhaustion itself. `workers=4 × subagents=3` against a 256 fd floor is an
  arithmetic concern plus a documented in-tree trap, not an executed measurement — no deep scan was
  run in a packaged build. Confirming it needs a packaged build (a dev build is not the shipped
  artifact) and a real deep scan; until then it is a risk, not a defect.

---

# Lane F — rows 122, 124, 125, 127, 135, 136, 138, 139

Audited at HEAD `e6f9208f14a9ddeea8fea901fd1b5e77bf33623b` on `feat/TCODE-000`.
**The brief named `f58f66a36f…`; HEAD had already moved when I started.** Every probe below is
against `e6f9208f`.

Method: `probe.sh` (git grep -a, bundled/generated artefacts excluded) with a positive control on
every absence claim. Applying Lane A's correction throughout: **a grep hit is a MENTION, not a USE** —
where it mattered I opened the file and separated call sites from comments, and I say which.

---

## Row 122 — `security/plugin/triage-backlog` (map 🟨)

**VERDICT** `not our surface`
**KIND** `never looked at`
**HEAD-STATUS:** `map still correct` — no codex commit since 2026-08-22 touches this.
**TAG** `[doc:codex]`

The one question that matters: the page describes `$codex-security:triage-finding`, a prompt-workflow
whose entire behaviour — SARIF/CVE ingestion, the `confirmed`/`not_actionable`/`needs_review` verdict
vocabulary, the per-queue exploitability ranks, the `SECURITY.md` read, the `$codex-security:fix-finding`
handoff — is implemented in the **third-party plugin's own skill instructions and MCP servers**. Not one
sentence names a host behaviour. We host the plugin; we do not implement the workflow.

Everything the page *does* need from a host is already governed by a different row's page: `$` skill
resolution → `skills-and-plugins` (row 127 below), plugin/connector install → `plugins.md` /
`build-plugins.md` (the two AGENTS.md-declared Codex contracts), read-only repo access and approvals →
`sandboxing.md` / `agent-approvals-security.md`. Taking this page as a contract would duplicate all four.

Two host-touching prerequisites I did measure, so the verdict is recorded rather than assumed:
- GitHub findings need `gh auth token` / `GH_TOKEN` / `GITHUB_TOKEN` reaching the agent process. The
  plumbing exists — `packages/shared/src/plugins/` maps plugin-MCP credential env sources
  (`{ GITHUB_TOKEN: 'GH_TOKEN' }`), `packages/shared/src/config/managed-env.ts:167` classifies
  `GH_TOKEN: 'credential'`, `packages/shared/src/mcp/client.ts:277` and
  `packages/session-tools-core/src/runtime/sandbox-env.ts:20` both list it. Probe: `GH_TOKEN` = 8 files,
  `GITHUB_TOKEN` = 8 files.
- `codex://plugins/plugin_connector_…` deep links (the Jira/Linear connector rows in the source table)
  are **unhandled**: `codex://` = 0 files, positive control `CODEX_HOME` = 27 files. Cosmetic — those
  links only appear in the rendered doc, never in our UI — but recorded rather than withheld.

Lane E already measured the shared substrate for this whole `security/plugin/*` family (`codex-security`
= 0 files; `openai-curated` = 3 test files only; live install proven at 32 MCP tools). I did not
re-derive it.

**COST** none if the verdict stands. Recording the verdict itself: one row note in the coverage map.
**CITATION** `learn.chatgpt.com/docs/security/plugin/triage-backlog.md#choose-the-findings-to-triage` — "Authenticated GitHub
REST access, such as `gh auth token`, `GH_TOKEN`, or `GITHUB_TOKEN`, with permission to read the
selected repository and finding type." (This is the page's ONLY host-touching requirement, and it is a
prerequisite the *user* supplies, not an obligation on our code. The page's other candidate sentence —
"Codex must be able to read the repository's source code" — sits in the intro before the first heading;
nearest normative section is `#choose-the-findings-to-triage`, cited above.)

---

## Row 124 — `security/plugin/vulnerability-reports` (map 🟨)

**VERDICT** `not our surface`
**KIND** `never looked at`
**HEAD-STATUS:** `map still correct`
**TAG** `[doc:codex]`

Same answer as 122 and for the same reason, but the page is even more purely promptware: 63 lines, not
one UI step, no config key, no protocol method. `$codex-security:vulnerability-writeup` groups findings
by root cause and writes `findings/<slug>/<slug>.md` plus `findings/<slug>/poc/`. All of that is the
plugin's skill doing file writes through ordinary tools.

The only host-side surface it touches is **write permission to the output directory**, and that is
governed by `sandboxing.md`/`permissions.md`, not here. Measured at HEAD: our codex config-writer emits
`default_permissions = "nessy_runtime"` with `extends = ":workspace"`
(`packages/codex-responses-adapter/src/config-writer.ts:956`, `:1004-1010`), so writes inside the
workspace succeed. **One real consequence worth the owner's eye:** the doc's own prompt template says
"write the reports to [output directory]" — a user who names a directory *outside* the workspace gets a
silent refusal from our profile. That is correct behaviour, not a bug, but it is behaviour the page
invites users into and nothing in our UI explains.

**COST** none. Recording the verdict: one row note.
**CITATION** `learn.chatgpt.com/docs/security/plugin/vulnerability-reports.md#use-reports-from-a-scan` — "When you request them,
Codex writes each report to `findings/<slug>/<slug>.md`, stores supporting files under
`findings/<slug>/poc/`, and links the report from `report.md`."

---

## Row 125 — `security-administration` (map 🟨)

**VERDICT** `not our surface` (the PAGE). See the severity line below for what the probe found anyway.
**KIND** `never looked at`
**HEAD-STATUS:** `map still correct` — and its inner measurement re-confirmed, then **sharpened**.
**TAG** `[doc:codex]`

> **SEVERITY — security-relevant, and worse than the map states.** Our codex runtime writes a permission
> profile with a `filesystem` sub-table and **no `network` sub-table at all**. Network posture on every
> codex session falls silently to whatever the built-in `:workspace` parent supplies.

The page itself is 100% a `<CodexDocsOverviewLanding …/>` JSX component — a link grid, no prose. Its
extracted anchor file contains **zero content anchors** (only nav/drawer ids), which is independent
confirmation there is no section to cite. So: `[doc:codex] no normative sentence — navigational page`.
The map put it 🟨 arguing the *subject* is ours; I agree the subject is ours, and that is exactly why the
finding belongs on `permissions` / `sandboxing` rows, not on a link grid.

Re-probed at HEAD, and the map understated it:
- `grep -a -i network packages/codex-responses-adapter/src/config-writer.ts` = **0 occurrences**;
  positive control `sandbox_mode` in the same file = **21**. Map claim holds exactly.
- **New, beyond the map:** the map framed the gap as the legacy `network_access` boolean
  (`config-schema.json` → `SandboxWorkspaceWrite.network_access`, default `false`). The *modern* gap is
  bigger. `PermissionProfileToml` has properties `['description','extends','filesystem','network',
  'workspace_roots']`, and its `network` → `NetworkToml` carries **13 keys**: `enabled`, `domains`
  (allow/deny lists), `mode`, `proxy_url`, `socks_url`, `mitm`, `unix_sockets`, `allow_local_binding`,
  `allow_upstream_proxy`, `enable_socks5`, `enable_socks5_udp`,
  `dangerously_allow_all_unix_sockets`, `dangerously_allow_non_loopback_proxy`. We emit
  `[permissions.nessy_runtime.filesystem]` and **never** `[permissions.nessy_runtime.network]`.
- The mechanism is **proven in this very repo**, just not on the codex path:
  `packages/server-core/src/pi-harness/isolation/windows.ts:130-131` writes
  `[permissions.<profile>.network]` / `enabled = <bool>` for the Pi harness. So this is not "codex can't
  express it" — it is one unwritten table.
- Corroboration from my own row 135: `learn.chatgpt.com/docs/web-search.md#configure-local-web-search` says web search "does not
  use the permission profile's network proxy or domain allowlist" — the doc is talking about a proxy and
  allowlist we never set.

**COST** real but bounded. `packages/codex-responses-adapter/src/config-writer.ts` (the `runtimePolicy`
shape at `:795-833` and the emit block at `:1002-1012`), ~30-60 lines to thread a network policy through
plus the TOML emit; 2-4 tests in `__tests__/config-writer.test.ts` (positive: `enabled=false` emitted;
negative: no `[…network]` table when unset). Depends on deciding what our network policy IS on the codex
runtime — today `denyNetworkEgress` exists on the isolation path but has no codex counterpart. Not
mechanical.
**CITATION** `[doc:codex] no normative sentence — navigational page`. The page is a link-grid component
with zero content anchors; every normative sentence it points at lives on `permissions.md`,
`sandboxing.md`, `sandboxing/auto-review.md`, `agent-approvals-security.md` and
`cloud/internet-access.md`, which are separate rows. **The finding above should be filed against
`permissions`/`sandboxing`, not against this row.**

---

## Row 127 — `skills-and-plugins` (map 🟨)

**VERDICT** `record the divergence as deliberate`
**KIND** `forgotten vs doc-parity`
**HEAD-STATUS:** `map still correct` — every code claim re-probed and standing.
**TAG** `[doc:codex]+[doc:claude]` — our mention syntax was built to neither page's spelling; it is a
host invention shared across all three runtimes (see below).

Map's code claims all re-confirmed at HEAD: `skill-creator` = 16 files, `plugin-creator` = 13,
`codexCapabilityId` = 1 (`format-adapters/codex.ts`, emitting `codexCapabilityId('skill', slug)` at
`:779`/`:786`/`:818`), `marketplace-registry-store` = 6, `registry-catalog-fetcher` = 4.

**The one hard divergence, measured.** The page's single testable normative sentence about our surface is
that Codex uses `$` mentions. We emit neither `$` nor `@`: `packages/shared/src/mentions/index.ts:169-182`
rewrites our own `[skill:slug]` marker into the English prose string
`[Mentioned skill: <name> (slug: <slug>)]` — runtime-agnostic, identical on Pi, Claude and Codex.
Probe: `Mentioned skill` = 5 files; `codex-security:` (a `$`-style qualified skill id) = **0 files
outside the coverage map itself.**

Why "deliberate" and not "bug": the prose marker demonstrably works — a plugin skill invoked on the codex
runtime is live-proven (`docs/testing/cdp-live-checklist.md`, MCP-W2). One host marker for three runtimes
is a defensible design. But the divergence is **unrecorded**, and it has a user-visible edge the pages
themselves create: every prompt template on rows 122 and 124 reads literally
`Use $codex-security:triage-finding to …`. A user copy-pasting a doc prompt into our composer gets no
resolution from us at all, and whether the codex app-server resolves the bare `$` text downstream is
**NOT-MEASURED** (would need a live run against a real installed `codex-security`; we call neither
`skills/list` nor `plugin/list`, so we could not even enumerate what a `$` would bind to).

**COST** to record only: one deviation-register entry. To close it: unknown, and I will not invent a
number — it depends on the unmeasured question above.
**CITATION** `learn.chatgpt.com/docs/skills-and-plugins.md#use-skills-for-repeatable-work` — "ChatGPT supports `@` mentions,
while Codex supports `$` mentions for skills."

---

## Row 135 — `web-search` (map 🟨)

**VERDICT** `record the divergence as deliberate`
**KIND** `forgotten vs doc-parity`
**HEAD-STATUS:** `map still correct` — with one measurement that *looks* like drift and is not.
**TAG** `[doc:codex]`

**The apparent drift is a false alarm, and worth stating so nobody re-raises it.** `web_search` now
returns **34 files** at HEAD versus the map's implied 3. Opened them: **31 are Pi's own unrelated
web-search tool** (`packages/pi-agent-server/src/tools/search/*`, `packages/shared/src/agent/pi-harness/*`).
On the codex path the count is unchanged: `packages/codex-responses-adapter/src/config-writer.ts` has
exactly **3** occurrences (`:641` comment, `:946-947` rationale, `:948` the emit), and
`__tests__/config-writer.test.ts` has **0**. The map's measurement stands verbatim. (Agrees with Lane A's
independent reading of `:948`.)

Re-confirmed absent at HEAD, all with the `sandbox_mode` = 6 files control:
`supports_standalone_web_search` = 0, `allowedWebSearchModes` = 0, `allowed_domains` = 0 (Lane A
concurs). `WebSearchMode` in the pinned `config-schema.json:4967` = `disabled|cached|indexed|live`,
matching the page.

**Our rationale is sound but incomplete against the page.** `config-writer.ts:946-947` says hosted
web_search "executes on OpenAI's backend — unreachable through the Nestor adapter". I verified the
premise: **every** codex session is pinned to `model_provider = "nessy_gateway"` with
`base_url = http://127.0.0.1:<adapterPort>/v1` (`:945`, `:994-996`) — a loopback translator. So hosted
search genuinely cannot round-trip. What the comment misses is that the page documents a mechanism for
*exactly our shape of provider*: `#search-with-a-custom-model-provider` shows a custom provider with a
`base_url` opting in via `supports_standalone_web_search = true`. Our gateway does not serve a compatible
search endpoint (memory: Nestor has no Responses API), so the answer stays "disabled" — but the reason is
"our gateway lacks the endpoint", not "the feature is impossible", and the difference is what a future
reader needs.

Second, smaller gap: the key is emitted unconditionally and **no test pins it**. `web_search` in
`config-writer.test.ts` = 0. A refactor could flip it to `live` and every suite stays green.

**COST** small. One characterization test in
`packages/codex-responses-adapter/src/__tests__/config-writer.test.ts` (~10 lines, asserting
`web_search = "disabled"` is present and that no other mode is emitted) plus a two-line amendment to the
`:946` rationale naming `supports_standalone_web_search` and why our gateway does not qualify. No
production behaviour change.
**CITATION** `learn.chatgpt.com/docs/web-search.md#search-with-a-custom-model-provider` — "Custom providers default to
`supports_standalone_web_search = false`."

---

## Row 136 — `whats-new` (map 🟨) — the digest, read

**VERDICT** `take the contract`
**KIND** `never looked at`
**HEAD-STATUS:** `map STALE: its worked example is BUILT` — `--approve-for-me`/auto-review, which the
map says is "handled nowhere", is fully wired at HEAD (7736e32a9 + 384e2fb38). Evidence below. The map's
*conclusion* (nobody reads the Codex digest) is nonetheless correct and I confirmed it independently.
**TAG** `[doc:codex]`

### First: the map's example is dead, and here is the proof

Map cell: "`GuardianApprovalReview` … `grep -a` over `codex-agent-server/src` + `shared/src` = 0". At HEAD:
`approvals_reviewer` = 5 files, `GuardianApprovalReview` = 3, `thread/approveGuardianDeniedAction` = 5.
These are **call sites, not mentions** — I opened them:
`packages/codex-responses-adapter/src/config-writer.ts:953` emits `approvals_reviewer = "auto_review"`;
`packages/shared/src/agent/backend/codex/event-adapter.ts:465-485,907,964` handles
`item/autoApprovalReview/{started,completed}`; `packages/shared/src/agent/codex-agent.ts:3105` issues
`client.request('thread/approveGuardianDeniedAction', …)`; the breaker is
`packages/shared/src/agent/backend/codex/auto-review-breaker.ts`. Row 136's cell must be rewritten.

### The digest IS a live feed nobody tracks — three independent confirmations

1. Citations: 0 for `whats-new`, 0 for `changelog` (per the brief's whole-repo count, not re-measured).
2. Corpus growth: Lane A re-fetched the live index and found the Codex corpus at **143 unique pages vs
   the map's 138** — five pages (`webmcp`, `developer-settings`, `developer-commands`,
   `enterprise/chatgpt-work-cloud-security`, `security/cli/ci/gitlab`) appeared in six days. Lane A owns
   those five; I did not touch them.
3. Model-family drift: `gpt-5.6` = **0 files** at HEAD (Lane A; control `xhigh` = 43 files) while the
   digest has named GPT-5.6 Sol/Terra/Luna since July 6.

### The headline number the owner actually wants

Our pinned runtime is `rust-v0.148.0` (`packages/codex-protocol/manifest.json:5`), which is **ahead of
the newest CLI the digest describes (0.147.0)**. So every feature below is already inside the binary we
ship — this is not "upgrade to get it", it is "we ship it and do not call it".

The pinned v2 schema declares **159 wire methods**. **26** are mentioned anywhere in our production code,
and applying Lane A's correction I opened all 26: **`command/exec`, `plugin/install`, `thread/read` and
`thread/resume` are comments only**, leaving **~22 methods actually wired out of 159 (≈14%)**.
(Bonus defect, one line: `packages/shared/src/agent/codex-agent.ts:2835` asserts `thread/resume` is among
methods "every one of which we already call" — there is no `thread/resume` call site at HEAD. The
rationale that comment supports is still sound; the parenthetical is false.)

### Entries naming a feature that touches our embedded app-server host — and where we stand at HEAD

Dated by the digest's own week heading. "OPEN" = not built at HEAD.

| Date | Digest entry | Feature touching our host | At HEAD |
| --- | --- | --- | --- |
| Aug 3–7 | `#organize-work-and-switch-agents-in-codex-cli-01470` | `--approve-for-me` / auto-review | **BUILT** (7736e32a9 + 384e2fb38) — map's example is stale |
| Aug 3–7 | same | Persistent, manually ordered chat **sections** | **OPEN** — `threadSection/{create,delete,list,update}` in schema, `threadSection/` = **0 files** |
| Aug 3–7 | same | Portable Agent Plugins; search across **local, personal, workspace, remote** catalogs | **OPEN as protocol** — `plugin/list` = 0, `plugin/install` = comment only. We run our own registry (`marketplace-registry-store.ts`), so this is a deliberate split, but the four *scopes* are unmapped |
| Aug 10–14 | `#bring-your-existing-agent-setup-and-work-with-you` | `/import` from Claude Code / Cursor; `ExternalAgentConfig/{detect,import}` in schema | **OPEN** — belongs to the `import` row (another lane); flagged here because the digest is where it surfaces |
| Jul 27–31 | `#organize-sessions-and-extend-codex-cli-01460` | "**For custom clients**, the app server can filter pinned threads, create in-memory forks, inspect installed connector state, and read connector metadata" | **OPEN, all four.** `thread/list` = 0; `thread/fork` IS called (`codex-agent.ts:2405`) but with only `{threadId,cwd,model,config}` — **`ephemeral`, `lastTurnId`, `approvalsReviewer` and `threadSource` are in `ThreadForkParams` and never passed**, so the in-memory fork specifically is unused; `ConnectorMetadata` = 0; `canonicalConnectorId` = 0 |
| Jul 27–31 | same | Experimental **WebSocket** app-server transport to remote Code Mode hosts | **OPEN** — `WebsocketThreadRealtime` = 0, `CodeMode` = 0, `code_mode` = 0 (schema has `CodeModeConfigToml`, `CodeModeHostConfigToml`, `WebsocketThreadRealtimeStartTransport`) |
| Jul 27–31 | same | **Standalone web search for compatible custom model providers** | **OPEN** — this is my row 135. The digest is the missing *why* behind `supports_standalone_web_search` |
| Jul 27–31 | same | Executor-provided skills | **OPEN as protocol** — `skills/list` = 0; our own capability resolver covers the need |
| Jul 20–24 | `#work-across-multiple-folders-in-one-local-project` | Multi-folder local projects, primary vs secondary folder | **OPEN** — `primaryFolder` = 0, `secondaryFolders` = 0 (`additionalDirectories` = 18 files is a *different* concept, our isolation write-roots) |
| May 18–22 | `#follow-long-running-goals` | **Goal mode** GA in "the Codex app, IDE extension, and CLI" | **OPEN** — `goal_mode` = 0, `goalMode` = 0 |
| May 11–15 | `#automate-trusted-workflows` | Hooks GA | **BUILT** — hooks are our best-cited Codex surface (9 citations of `hooks` per the brief) |
| May 11–15 | same | Enterprise **Codex access tokens** for CI/schedulers | **OPEN** — `access-tokens` = 1 file (`claude-doc-pages.tsv`, i.e. the Claude corpus listing, not code) |
| Mar 9–13 | `#let-codex-inspect-terminal-output` | Agent reads the integrated terminal | **OPEN** — `integratedTerminal` = 0, `integrated-terminal` = 1 file (a doc listing) |
| Mar 2–6 | `#run-codex-natively-on-windows` | Native Windows sandbox | **BUILT, mode-divergent** — see row 138 |
| Aug 10–14 | `#use-the-chatgpt-desktop-app-on-linux` | Desktop app on Linux (.deb/.rpm, x64+ARM64) | **We already ship Linux** (`build-linux.sh`) — parity, no action |

**One negative worth recording, so it is not mis-attributed later.** Lane E found a real defect —
`packages/codex-responses-adapter/src/config-writer.ts:236-243` maps `xhigh → high` and `max → high`
while codex's schema takes an open string, a silent two-level downgrade on every turn (I verified the
table at those lines). It is NOT a digest finding: the only `whats-new` entry naming reasoning effort,
`#choose-how-gpt-56-responds-in-chatgpt` (Aug 3–7), explicitly disclaims our surface — "These changes
apply to ChatGPT conversations. They don't change model behavior in ChatGPT Work or Codex." Lane E's
defect belongs to the models/config rows, not to row 136.

Deliberately excluded as not-our-surface (cloud/mobile/consumer): Sites, Voice, Computer Use/appshots,
Record & Replay, the Chrome extension, GitLab-in-Codex-cloud, Codex Micro, iOS Remote, education plugins,
Security Review, the Codex Security CLI/SDK, Bedrock (its own row). Probed anyway and all 0:
`record-and-replay` = 1 file (doc listing), `appshot` = 1 (doc listing).

**COST** for the row itself: unknown per feature, and I will not fabricate one — each open item above is
its own sizing exercise. The cost of the *contract* is small and concrete: add
`learn.chatgpt.com/docs/whats-new.md` + `changelog.md` to the AGENTS.md "Upstream Docs Are Contracts"
section as a Codex corpus with a re-read cadence, exactly as the Claude digest already earns via parity
row R48. Cheapest useful artefact: a checked-in list of the 159 schema methods with our ~22 marked, so
the next pin bump diffs mechanically instead of by hand. ~1 script + 1 fixture.
**CITATION** `learn.chatgpt.com/docs/whats-new.md#organize-sessions-and-extend-codex-cli-01460` — "For custom clients, the
[app server](https://learn.chatgpt.com/docs/app-server) can filter pinned threads, create in-memory
forks, inspect installed connector state, and read connector metadata."
(Second, for the stale example: `learn.chatgpt.com/docs/whats-new.md#organize-work-and-switch-agents-in-codex-cli-01470` — "Use
`--approve-for-me` to enable [automatic approval review](…) for eligible requests without expanding
filesystem or network permissions.")

---

## Row 138 — `windows/windows-sandbox` (map 🟨)

**VERDICT** `record the divergence as deliberate` — but only after an owner call; see the honest reading.
**KIND** `forgotten vs doc-parity`
**HEAD-STATUS:** `map still correct` — verbatim requirement verified in the page, every code claim
re-probed at HEAD and unchanged.
**TAG** `[doc:codex]`

> **SEVERITY — security-relevant.** The population that turns our isolation ON is precisely the
> enterprise/security-conscious one, and it is the only population affected: they get the doc's *weaker*
> sandbox with no way to ask for the stronger one.

**The requirement, verified verbatim in the page** (`#configure-the-windows-sandbox`): "If both modes are
available, use `elevated`." The page also supplies the surrounding contract: `elevated` "uses dedicated
lower-privilege sandbox users, filesystem permission boundaries, firewall rules"; `unelevated` "runs
commands with a restricted Windows token derived from your current user… and uses environment-level
offline controls instead of the dedicated offline-user firewall rule. It's weaker than `elevated`"; and
"Codex prefers `elevated` when no mode is selected."

**Re-probed at HEAD — the map is exactly right:**
- `packages/server-core/src/pi-harness/isolation/windows.ts:129-131` still hard-writes
  `[windows]` / `sandbox = "unelevated"` / `sandbox_private_desktop = true` as a string literal inside
  `renderPermissionProfile`. No parameter, no setting, no branch. `unelevated` = 2 files (that file +
  `isolation.test.ts`); `elevated` = 17 files (mostly unrelated).
- `codex-windows-sandbox-setup.exe` is **fetched, sha256-pinned and existence-checked but never
  executed**: `setupCommand` = 5 files, and all five are a path — `windows.ts:22` (a name constant),
  `runtime-resolver.ts:178-183` (`existsSync` + `realpathSync`), `types.ts:369` (a field), and two test
  files. Zero spawn sites. Confirmed by reading, not by counting.
- `allowed_sandbox_implementations` (the `requirements.toml` key by which an admin *forces* `elevated`)
  = **0 files**. Positive control `sandbox_mode` = 6 files, `CODEX_HOME` = 27.
- **New, beyond the map:** the pinned protocol carries three RPCs for exactly this —
  `windowsSandbox/readiness`, `windowsSandbox/setupStart`, `windowsSandbox/setupCompleted`, plus
  `WindowsSandboxSetupStartParams = { mode: "elevated"|"unelevated", cwd? }`. All three = **0 files** at
  HEAD; positive control `thread/start` = 18 files. So the app-server would *do the elevated setup for
  us* on request and we never ask.

**The honest reading, which changes the framing.** This code is our **Pi-harness host isolation** reusing
`codex.exe sandbox` as an isolation primitive — it is not Codex's own agent sandbox. Two consequences:
1. `unelevated` is the mode that survives enterprise policy — the page itself says it "is still useful
   when administrator-approved setup is blocked by local or enterprise policy," and `elevated` setup
   needs UAC, local user/group creation and firewall changes. Hard-writing `unelevated` is therefore a
   *defensible* choice for a desktop app that must not prompt for admin. The backend label is even
   honest about it: `codex-windows-restricted-token:…` (`windows.ts:250`) names the restricted-token
   mechanism the doc attributes to `unelevated`.
2. Exposure is bounded by `SANDBOX_ENABLED_DEFAULT === false` — verified at HEAD
   (`packages/shared/src/config/__tests__/sandbox-settings.test.ts:553-554`; owner decision 2026-08-12,
   `sandbox-default-off-until-agent-stabilization`; `config-doctor.ts:489` prints "disabled (config
   default)"). Isolation is off unless a user or admin turns it on.

So: not a bug, and not a crisis — but an **unrecorded** divergence from a verbatim "use `elevated`",
with the strong-mode path already sitting in the protocol we ship. Our deviation register discusses
win32 isolation only against Claude's `sandbox-environments.md`
(`docs/superpowers/specs/2026-07-29-deviation-register.md:291`), never against this page.

**COST** to record: one deviation-register entry, ~10 lines, no code. To close it properly:
`packages/server-core/src/pi-harness/isolation/windows.ts` (thread a mode through `renderPermissionProfile`
+ `resolveWindowsIsolation`, ~40 lines), a readiness probe via `windowsSandbox/readiness` and a
`windowsSandbox/setupStart` call in the app-server client (~60 lines, new territory — we call no
`windowsSandbox/*` method today), a settings key, and honouring `allowed_sandbox_implementations`.
Tests: `isolation.test.ts:70-71` already pins both keys and would need a mode matrix (~4 cases).
**Depends on** an owner decision about triggering a UAC prompt from a desktop app — that is a product
call, not an engineering one, and it is why I stop at "record the divergence".
**Cannot be verified here:** no Windows host on this rig. `NOT-MEASURED: whether `elevated` setup
actually succeeds under our packaging — needs a real Windows box.`
**CITATION** `learn.chatgpt.com/docs/windows/windows-sandbox.md#configure-the-windows-sandbox` — "If both modes are available,
use `elevated`."

---

## Row 139 — `windows/wsl` (map 🟥)

**VERDICT** `record the divergence as deliberate`
**KIND** `forgotten vs doc-parity` (the map filed it as a product gap; the measurement disagrees — see
below)
**HEAD-STATUS:** `map WRONG: its severity argument is inverted` — the absence is real, the *reason* it
was called 🟥 does not survive measurement.
**TAG** `[doc:codex]`

**The absence, with the positive control the brief requires.** `WSL`/`WSL2` (word-boundary, `git grep -a`)
= **3 files at HEAD**, and all three are comments quoting **Claude's** docs:
`packages/shared/src/config/managed-system-paths.ts:7`, `sandbox-settings.ts:81`, `:1194`/`:1196`. A
fourth hit is `scripts/claude-doc-pages.tsv:121` (the Claude corpus listing, `desktop-wsl`). No WSL
detection, no `WSL_DISTRO_NAME` (= 0), no `wsl.exe` (= 0), no `microsoft-standard` kernel check (= 0).
**Positive control on the same probe run:** `win32` = 123 files, `linux` = 69, `bwrap` = 12,
`bubblewrap` = 4. The platform branches are unmistakably real; WSL is genuinely absent.

**Is this a real product gap for our Windows users, or an acceptable scope decision? — an acceptable
scope decision, and I can say why with evidence.** The map argued 🟥 because "a Windows user whose domain
policy blocks the native install has no fallback." Three measurements refute that chain:

1. **We already ship the doc's own policy fallback.** The page's sibling
   (`learn.chatgpt.com/docs/windows/windows-sandbox.md#configure-the-windows-sandbox`) says `unelevated` "is still useful when
   administrator-approved setup is blocked by local or enterprise policy" — and `unelevated` is the mode
   we hard-write (row 138). The policy-blocked user is the one case we *do* handle. The map read our
   `unelevated` hard-write as the weakness that makes WSL necessary; it is the opposite.
2. **The fail-closed path is not a policy failure.** `isolation.test.ts:80` fails closed when the
   *runtime* is unavailable, and the remediation text names the actual cause: "the Windows sandbox
   toolchain (codex.exe, codex-command-runner.exe, codex-windows-sandbox-setup.exe) is missing or failed
   sha256 manifest verification; reinstall the app" (`isolation-remediation.ts`). That toolchain ships
   **inside our bundle** (`build-win.ps1:438-448`, pins verified by `scripts/build/codex-integrity.ts`).
   Domain policy does not remove it.
3. **And it is reached only when isolation is on**, which by `SANDBOX_ENABLED_DEFAULT === false` it is
   not, by default (verified — see row 138).

**The doc itself scopes WSL away from our product shape.** `windows-sandbox.md` states the app "can run
natively in PowerShell with a Windows sandbox instead of requiring WSL or a virtual machine," and the
digest's Windows launch entry (`learn.chatgpt.com/docs/whats-new.md#run-codex-natively-on-windows`) says "WSL remained available
for developers who preferred a Linux environment" — i.e. WSL is the **CLI/VS Code** path, not the desktop
app path. A win32 Electron app cannot run "inside" WSL; only our Linux build could, under WSLg.

**And that last point is the actually interesting one, which the map missed:** our Linux isolation
already uses `bwrap` (`bwrap` = 12 files, `bubblewrap` = 4), and the page's only version-normative
sentence says the Linux sandbox moved to `bubblewrap` in Codex `0.115` (we pin `0.148.0`). So a Nessy
**Linux** build running under WSL2 would get precisely the mechanism this page describes — for free.
What is missing is not capability but a **statement**: nothing detects WSL, nothing declares it
supported or unsupported, and no doc says which of our three artefacts a WSL user should install.

**COST** to record: one deviation-register entry, ~10 lines, zero code — and it should say "WSL is out of
scope for the win32 desktop artefact; the Linux artefact is untested under WSLg." To go further (a
supported story): unknown, and it starts with a product decision, not code. A cheap middle step exists —
a WSL detection line in `config-doctor` so a WSL user's report says so — ~5 lines plus 1 test, but only
worth it if the owner wants WSL supported at all.
**Cannot be verified here:** `NOT-MEASURED: whether our Linux .deb/.rpm actually runs under WSLg and
whether bwrap is available in a default WSL2 distro. Needs a Windows host with WSL2; none on this rig.`
**CITATION** `learn.chatgpt.com/docs/windows/wsl.md#launch-vs-code-from-inside-wsl` — "WSL1 was supported through Codex `0.114`.
Starting in Codex `0.115`, the Linux sandbox moved to `bubblewrap`, so WSL1 is no longer supported."
(The page's core sentence — "When you use WSL2, Codex runs inside the Linux environment instead of using
the native Windows sandbox. Choose WSL2 when you need Linux-native tooling… or neither native Windows
sandbox mode works for your environment" — sits in the intro **before the first heading**; per the brief
I cite the nearest normative section, `#launch-vs-code-from-inside-wsl`, and name that I did so.)

---

## Lane summary

- 8/8 rows done.
- VERDICTS: `not our surface` ×3 (122, 124, 125) · `record the divergence as deliberate` ×4 (127, 135,
  138, 139) · `take the contract` ×1 (136).
- KINDS: `never looked at` ×4 (122, 124, 125, 136) · `forgotten vs doc-parity` ×4 (127, 135, 138, 139) ·
  `bug` ×0.
- HEAD-STATUS: `map still correct` ×6 · `map STALE` ×1 (136) · `map WRONG` ×1 (139, severity inverted).
- Severe: **row 125** — codex permission profile emits `filesystem` and never `network`, a 13-key table
  (the mechanism is already implemented for the Pi harness on Windows); file it against
  `permissions`/`sandboxing`, not against a link-grid page. **Row 138** — `unelevated` hard-written
  against a verbatim "use `elevated`", with three `windowsSandbox/*` RPCs shipped and never called;
  bounded by isolation being off by default.
- NOT-MEASURED: whether the codex app-server resolves a bare `$skill` from user text (row 127); whether
  `elevated` setup succeeds under our packaging (row 138, no Windows host); whether our Linux artefact
  runs under WSLg with bwrap (row 139, no Windows host).
- Cross-lane: row 136's digest is the missing rationale for row 135's `supports_standalone_web_search`,
  and its `#organize-sessions…-01460` entry is where four unbuilt app-server capabilities are announced
  "for custom clients" — i.e. for us.
