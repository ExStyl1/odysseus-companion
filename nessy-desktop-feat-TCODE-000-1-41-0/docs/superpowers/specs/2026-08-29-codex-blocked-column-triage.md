# P2.310 / P2.308 — the codex map's ⛔ column, re-triaged, and the nine pages nobody had opened

**Read-only audit, 2026-08-29, branch `feat/TCODE-000`.** Six lanes (five ⛔ chunks + one new-pages lane), every page
re-fetched from `https://learn.chatgpt.com/docs/<slug>.md` on the same day, every probe re-run against HEAD with a
positive control on the same run. No source file was changed by this pass; the map cells it produced are applied in
`2026-08-22-codex-coverage-map.md` and the corpus snapshot in `scripts/codex-doc-pages.tsv`.

Companion to `2026-08-28-codex-sweep-triage.md` (P5.2, which covered 🟨 and 🟥 and deliberately left ⛔).

---

## 0. The three headline numbers, and the one that surprised

| | |
| --- | --- |
| ⛔ rows re-read | **73 of 73** |
| Verdicts that MOVED off ⛔ | **4** — rows 60 → 🟥, 69 → 🟨, 88 → 🟨, 94 → 🟨 |
| Cells rewritten with the verdict UNCHANGED | **24** |
| Corpus pages with no row | **9** (not 5 — see §3) |
| Map rows | 139 → **148** |

**The ⛔ column was mostly right, and that is the finding, not an anticlimax.** The plan row expected the same
distribution risk the 🟨/🟥 columns showed — "a ⛔ that was correct in July may be wrong now that three runtimes ship
where one did". Measured, it mostly was not: 69 of 73 stand. The security cluster moved **zero of fifteen**, because
Codex Security ships as a separate npm package, a ChatGPT-desktop sidebar and a cloud service, each pinned by its own
page — a shape, not a shrug.

**What was wrong was the EVIDENCE, in 24 rows with a correct verdict.** That is the more dangerous half: a reader
takes a right verdict with a dead justification for a measurement. Four examples, all measured this pass:

- **Row 14 `appshots`** said `allowAppshots` exists nowhere in our tree. It is a field of the managed
  `ConfigRequirements` struct we read, already carrying an explicit verdict `'inapplicable'`
  (`packages/shared/src/agent/codex-config-requirements.ts:254`). The cell also said `desktopCapturer` = 0; it is 1.
- **Row 25 `cloud/internet-access`** said we have no domain allowlist. We have one
  (`network-address-guard.ts:239`) — for a different subject (our host's egress, not the agent's). The verdict
  survives; the sentence that justified it did not.
- **Row 99 `remote`** said the page names "ни одного поля протокола/конфига". Measured: four `RemoteControl*` types,
  `remoteControl/status/changed`, `allowRemoteControl` in `ConfigRequirements`, an env kill-switch in the binary — and
  our own `codex-config-requirements.ts:255` already classifies it `'codex'`.
- **Row 39 `cyber-safety`** claimed `Daybreak` = 0 repo-wide. It is 1 — and the 1 is the corpus TSV line, i.e. the
  probe was matching the audit's own snapshot. Same self-match defeated row 69's `feature.maturity` = 0.

**A probe that matches the map's own denominator is not a measurement of the product.** Two of 73 rows had one.

---
## 1. The 73 rows, one line each

| # | Страница | Вердикт | Kind | Сила доказательства | Ячейка переписана | Лейн |
| --: | :-- | :-- | :-- | :-- | :-: | :-: |
| 1 | codex-manual | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 2 | administration | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 6 | agent-configuration/speed | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 9 | app | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 10 | reference/commands | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 11 | windows/windows-app | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 12 | reference/settings | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 14 | appshots | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 21 | chrome-extension | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 22 | codex/cli | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) + HEAD probe | — | C |
| 23 | cli-customization | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) + HEAD probe | — | C |
| 24 | cloud | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | D |
| 25 | cloud/internet-access | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | D |
| 34 | configuration | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 35 | custom-prompts | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |
| 36 | customization/computer-history | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 39 | cyber-safety | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | C |
| 41 | developers | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) | **да** | D |
| 42 | enterprise/access-tokens | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) | **да** | A |
| 44 | enterprise/analytics-api | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 45 | enterprise/usage-limits | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 46 | enterprise/work-admin-faq | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 47 | enterprise/chatgpt-work-overview | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | A |
| 48 | enterprise/compliance-api | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 49 | enterprise/windows-deployment | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 50 | enterprise/governance | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 51 | enterprise/gpts-and-sharing | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 52 | enterprise/groups-and-provisioning | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 56 | enterprise/prisma-airs | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 57 | enterprise/roles-and-workspace-permissions | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | A |
| 58 | enterprise/service-accounts | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 60 | enterprise/workload-identity | → 🟥 | never looked at | strong (source/binary) | **да** | A |
| 61 | enterprise/workspace-analytics | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 63 | environments/cloud-environment | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | A |
| 68 | extend/record-and-replay | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | D |
| 69 | feature-maturity | → 🟨 | forgotten vs doc-parity | strong (source/binary) | **да** | D |
| 70 | features | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) | **да** | D |
| 71 | features/voice | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | D |
| 72 | features/codex-micro | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | D |
| 73 | get-started-with-work | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | D |
| 74 | github-action | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) + HEAD probe with control | **да** | D |
| 77 | codex/ide | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | D |
| 82 | linux/linux-app | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) | **да** | D |
| 84 | mcp-server | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) + HEAD probe with control | **да** | D |
| 86 | non-interactive-mode | keep ⛔ | n/a (verdict unchanged) | strong (source/binary) + HEAD probe with control | — | D |
| 88 | open-source | → 🟨 | never looked at | strong (HEAD probe + control) | **да** | E |
| 92 | pets | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 94 | pricing | → 🟨 | forgotten vs doc-parity | strong (source/binary + HEAD probe with control); the page half  | **да** | E |
| 97 | quickstart | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 99 | remote | keep ⛔ | bug (in the cell's evidence, not i | strong (source/binary + HEAD probe with control) | **да** | E |
| 103 | security | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 104 | security/cli/faq | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 105 | security/cli | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 106 | security/cli/reference | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) for the verdict; weak (page only | **да** | B |
| 107 | security/faq | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 108 | security/setup | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 109 | security/plugin/changelog | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 111 | security/sdk | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 112 | security/plugin/export-findings | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | B |
| 114 | security/threat-model | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 119 | security/cli/bulk-scans | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 120 | security/cli/ci | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | B |
| 121 | security/security-review | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | B |
| 123 | security/plugin/workbench | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | B |
| 126 | sites | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | **да** | B |
| 128 | third-party/github | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) for the absence; strong (source/bi | — | E |
| 129 | third-party/gitlab | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 130 | third-party/linear | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 131 | third-party/slack | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 132 | use-chatgpt | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 133 | visualizations | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 134 | web | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | E |
| 137 | windows/windows-app | keep ⛔ | n/a (verdict unchanged) | strong (HEAD probe + control) | — | C |

---

## 2. The four that moved, with what the ⛔ had missed

### Row 60 `enterprise/workload-identity` ⛔ → 🟥 — the one that is not bookkeeping

The ⛔ answered *"do we have this feature?"* and stopped. Measured live at HEAD, the page's subject **reaches our
process**: one WIF environment variable kills our bundled app-server before `initialize` (exit 1), and both WIF vars
make it call `auth.openai.com` at startup — with our own `config.toml` loaded. Our side never settles the promise
either way. So this is not "a workspace feature we do not offer"; it is an unowned startup-path behaviour, which is a
gap. **Evidence: strong (measured against the shipped binary).**

### Row 69 `feature-maturity` ⛔ → 🟨

Both ⛔ premises false at HEAD. The page defines the semantics of a field the app-server really sends —
`ExperimentalFeature.stage`, whose vendored enum carries four of the page's five labels verbatim — and the
"no receiver" probe only ever matched the corpus TSV. Our side: the bundled `config-schema.json` `[features]` table has
**124 keys**, we write **two** of them blind and drift-guard only their names, and `experimentalFeature/list` — the only
source of a stage, already measured live at 114 features — is called by nobody. **Page and binary disagree on the
vocabulary** (the page lists "Experimental", the enum does not; the enum has `removed`, the page does not) — recorded,
not reconciled on the page's word, per `AGENTS.md`.

### Row 88 `open-source` ⛔ → 🟨, and it corrects a premise

The page names our own supply chain: `scripts/fetch-codex.mjs` pulls `codex-app-server` straight from
`github.com/openai/codex` Releases at `rust-v0.148.0`, double SHA-verified. Premise correction worth carrying: the page
has **no licence text and no build instructions**, so it is not the licence contract it was assumed to be. Its
`openai/skills` corpus is 0 repo-wide against `openai/plugins` = 19.

### Row 94 `pricing` ⛔ → 🟨

The ⛔ read the page as billing and stopped at the paywall. The bundled app-server carries a complete **unused usage
surface** — `account/rateLimits/read`, `account/usage/read`, `account/rateLimits/updated`, `RateLimitSnapshot` /
`RateLimitWindow`, and the `x-codex-credits-*` headers our own loopback adapter would emit. Ours = 0; control
`turn/start` = 22. The page's `#feature-availability` table also has an **API Key column, which is our column.**

---

## 3. The corpus grew to 147, not 143 — and the two ways it hides

P5.2 measured 143 on 2026-08-28 and named five uncovered pages. Re-measured 2026-08-29: **147 unique slugs, nine
uncovered.** Four appeared in a single day, all enterprise. Two traps, both of which UNDERCOUNT:

1. **Query strings.** Five index entries are spelled `…/developer-commands.md?surface=cli` / `?surface=ide`. A regex
   anchored on `\.md\)` drops all five and loses two whole slugs (`developer-commands`, `developer-settings`). This
   lane hit that trap itself on its first extraction and got 145.
2. **Data lines are not pages.** `windows/windows-app` is listed twice by upstream, so the old snapshot's "139 pages"
   were 138. Map rows 11 and 137 are that duplicate, confirmed byte-identical this pass (normalising the row number
   makes both lines hash the same).

Both are now checked by `scripts/check-coverage-map.ts`, which reads the codex map for the first time (§6).

| New row | Page | Вердикт | Kind | Why it matters |
| --: | :-- | :-- | :-- | :-- |
| 140 | `webmcp` | 🟥 | never looked at | Site tools land on the built-in browser we ACTUALLY SHIP; `WebMCP`/`webmcp`/`document.modelContext` = 0 |
| 141 | `developer-settings` | 🟨 | forgotten vs doc-parity | Indexed as `?surface=ide`, but the `.md` carries an `id="cli"` block that is the `config.toml` precedence contract we write into |
| 142 | `developer-commands` | 🟨 | forgotten vs doc-parity | Carries `### codex app-server` — our own spawn contract — and our tree already holds a measurement that CONTRADICTS it (§4) |
| 143 | `enterprise/chatgpt-work-cloud-security` | ⛔ | never looked at | "Work Cloud runs on shared, OpenAI-managed infrastructure" — pins itself |
| 144 | `security/cli/ci/gitlab` | ⛔ | never looked at | Separate `@openai/codex-security` product on an OpenAI Platform key we do not hold; being a GitLab shop does not change it |
| 145 | `enterprise/admin-plugin` | ⛔ | never looked at | It is *the Admin plugin*, one hosted plugin — not admin-managed plugins; defines no manifest field |
| 146 | `enterprise/plugin-management` | 🟨 | forgotten vs doc-parity | This is codex's `plugin-marketplaces.md`: `git-subdir` / `ON_USE` / `NOT_AVAILABLE` / `.app.json` / `interface` are all already implemented here, citing a DIFFERENT page |
| 147 | `enterprise/chatgpt-work-local-security` | ⛔ | never looked at | The word `Codex` appears **0 times**; its `requirements.toml` keys are already verdicted `'inapplicable'` in our own source |
| 148 | `enterprise/chatgpt-work-usage-and-cost` | ⛔ | never looked at | Credits and billing; no runtime, protocol, file or config key |

**Two of the nine would have been misjudged on their index line alone**, in opposite directions: `developer-settings`
reads as an IDE page and is a CLI config contract; `admin-plugin` reads as an admin-managed-plugin contract and is a
usage guide for one hosted plugin. The brief's own expectation about `chatgpt-work-local-security` also inverted under
measurement — the "local" page is FURTHER from us than the cloud one, by its own zero mentions of Codex.

**And five page SUBJECTS were rewritten upstream in the same seven days**, which no probe of our tree can see:
`mcp-server` is now `Deprecated. Use the Codex app server or the Codex plugin for Claude Code` — the app server is
exactly what we drive; `hooks` widened from "Run deterministic scripts" to "Run scripts **or MCP tools**";
`automations` gained app-event triggers; `chrome-extension` gained four browsers; `windows/windows-app` was reworded.

---

## 4. Findings this pass produced that are NOT map cells

The controller opens rows; this lane records. Each is measured, with the probe and its control in the lane files.

| # | Finding | Where it was found | Why it is not a cell |
| --: | :-- | :-- | :-- |
| T1 | **A plugin following codex's own documented layout loses everything every session.** `security/cli/reference` publishes `$CODEX_HOME/state/plugins/<name>/` (incl. `workbench.sqlite3`). Our `CODEX_HOME` is `mkdtempSync(tmpdir(), 'nessy-codex-home-')` (`codex-agent.ts:1434`) and is `rmSync`'d at teardown (`:4283`). Not "we have no plugin persistence" — we grant one at a DIFFERENT root, `runtime.dataPath`. Awareness: `state/plugins` 0, `CODEX_SECURITY_STATE_DIR` 0, control `CODEX_HOME` 35. Sharpened by Dev-16 blessing the install path. | row 106 | product decision, spans code |
| T2 | **A failed required MCP server yields a thread that starts anyway.** `app-server.md` states a `required` MCP server failing to initialize makes `thread/start` AND `thread/resume` fail. `required` is a real `RawMcpServerConfig` key in the bundled schema and we never write it for `[mcp_servers.session]` / `[mcp_servers.sources]` (nor `startup_timeout_ms` / `tool_timeout_sec`; `listMcpServerStatus` called by nobody). Today the agent silently runs without its session tools. One key to fix; the trade (hard failure vs degraded session) is a **product posture worth stating rather than deciding quietly.** | row 84 lane, belongs to row 13 | posture, not coverage |
| T3 | **We tell an administrator a policy is enforced when nothing enforces it.** `chatgpt-work-local-security` names `features.in_app_browser = false` ("Disable the desktop app's built-in browser") as a managed security setting; the binary knows the key; we ship a browser pane; and `codex-config-requirements.ts:288` routes every unrecognised `featureRequirements.*` to `'codex'`. Same shape as the finding that produced `managed-in-app-updates.ts`. | new row 147 | a defect with a fix, not a verdict |
| T4 | **Third measured instance of codex SOURCE outranking codex PAGE.** `learn.chatgpt.com/docs/developer-commands.md#codex-app-server` says `codex app-server --stdio` is an alias for stdio transport; `packages/codex-agent-server/src/runtime-manager.ts:4-6` records that the standalone binary we ship **does not accept** `--stdio`. Both true of different artifacts; the page draws no such distinction. **A lane "fixing" our spawn to match the doc would break it.** | new row 142 | it is a warning, not a gap |
| T5 | **A remote-control transport we neither enable nor explicitly disable.** See row 99 in §0. Unowned residue. | row 99 | needs an owner call |
| T6 | **`Dev-16` covers 8 rows, not "the whole `security/plugin/*` cluster" (11).** The three omitted are exactly 109, 112, 123 — each ⛔ on its own reason, so nothing is uncovered, but the deviation's own wording overstates its reach. | chunk B | bookkeeping on the plan |
| T7 | **A second documented instance of a permission profile overriding `sandbox_mode` / `approval_policy`**, plus a RESERVED profile id `codex_security_scan` our writer must not collide with. Marked **WEAK — page only**: the section scopes itself to "CLI and SDK scans", so it does NOT resolve P5.2 §0.1. | row 106 | evidence for an existing severe row |
| T8 | **`experimentalFeature/list` is never called** and we write 2 of 124 `[features]` keys blind, drift-guarding only their names. Configuration, not construction — one startup call would let us assert the stage of both keys we write. | row 69 | native-first: the mechanism exists and is unused |

---

## 5. Evidence strength, stated per the non-symmetric rule

`AGENTS.md`: for codex, `github.com/openai/codex` and the shipped binary are **strong**; `developers.openai.com` /
`learn.chatgpt.com` alone is **weak — intent, not behaviour**, and such a cell is a hypothesis about the binary.

Of the 73 ⛔ rows, **every one carries strong evidence** (a HEAD probe with a positive control, or the vendored
source / bundled binary). Three cells carry a page-only component, and only those three:

| Cell | The page-only half | What would settle it |
| :-- | :-- | :-- |
| Row 94 `pricing` | the plan/credit semantics half | a live run against the gateway upstream |
| Row 106 `security/cli/reference` (finding T7) | the profile-precedence sentence | the same live run P5.2 §0.1 already needs |
| New row 141 `developer-settings` | **every behavioural claim the page makes**; only the code side is probed | reading the IDE extension's own source, which we do not vendor |

Nothing in this pass upgraded a cell on a page alone.

---

## 6. What now reads the codex map

Before this pass: nothing. `scripts/check-coverage-map.ts` hardcoded the Claude map's path, so the codex map's counts,
glyph legality, row completeness and denominator were gated by **no reader at all** — while its verdicts moved.

It now audits both, from one `MAPS` list so a third cannot be added and left unread, with the shape differences
declared rather than hardcoded (one verdict column vs a three-runtime axis; `⛔` vs `⬜`; no evidence marker, and
carrying one is an error here; `windows/windows-app` pinned as a legitimate duplicate SLUG where the Claude map pins
duplicate NUMBERS). Two checks are new for both maps:

- **a row whose page is in no snapshot line** — the direction nobody checked, and the one that catches a stale
  denominator. It is what now names all nine uncovered pages by itself;
- **the snapshot's own `Snapshot: <date>, <n> pages` header against its unique slugs** — the line `AGENTS.md` tells
  every reader to trust over any count in prose, and which said 139 while holding 138.

Both went red on the real files the moment they were written, and both are green now.

---

## 7. What could not be verified, and why

- **Whether the bundled binary implements the documented `default_permissions` precedence** (P5.2 §0.1). Unchanged by
  this pass; it needs one live session. Finding T7 adds a second page saying the same thing and does not resolve it —
  two page-only statements are not a measurement.
- **Whether the codex binary reads `.agents/skills` from cwd on its own.** Our projection reaches it via
  `CODEX_DEFAULT_SKILLS_DIR`; that is a different claim and is recorded as such in map row 37.
- **Row 60's full consequence.** The startup call to `auth.openai.com` and the exit-1 kill were measured; what our
  product SHOULD do about either is an owner call, not a measurement.
- **`--code-mode-host`** = 0: an outbound app-server connection shared by every thread, noticed and not examined.
- **Live confirmation of `CDX-ROLES`**, BLOCKED since 2026-08-21 on a lost rig fixture. Eight days, unchanged.

## 8. One rig hazard, because it produced a zero that looked like a bug

Six lanes shared one scratch directory, and one lane's `llms.txt` was overwritten mid-run by another lane fetching the
CLAUDE index into the same name. The failure presents as a silent zero that looks exactly like a broken regex. Every
quoted description in this file was re-verified against a private re-fetch. **Under a fan-out, name scratch files per
lane** — an absence measured against another lane's file is not an absence.
