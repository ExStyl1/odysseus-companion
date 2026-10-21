# Run of 2026-08-21 — W-pkg, the packaged wave (cross-runtime history carry)

> **Read this first, added 2026-09-11 — the codex result below is a reading at
> `rust-v0.148.0`, and that binary is no longer the one we ship.** The pin moved
> to `rust-v0.150.1` on 2026-09-11 (P7.2, `f042e5674`; app-server self-report
> `0.150.1`), and the live case moved with it — RE-POINTED, never renamed:
> `scripts/cdp/cases/cdx-150.ts` supersedes the 0.148-era case the way that one
> superseded the 0.147-era one (`d014ab97d`). The case's own rule is why this note
> replaces an edit to the numbers: **a foreign runtime's version bump invalidates
> every row measured against the previous one** — it is a different program
> speaking the same protocol, and the app-server protocol is exactly where our
> adapter lives.
>
> The same lift retired a setting the app wrote for every codex session on the day
> of this sitting: `approval_policy = "untrusted"` is FATAL at 0.150.1 — the
> process exits 1 before answering `initialize` — and the host emitted it whenever
> the sandbox master switch is off, which is the shipped default (R13's config
> half; `codex-agent.ts`'s own docblock said so from 2026-08-17), until the lift
> degraded it to `on-request` (`9375093b4`). So neither the binary nor the
> configuration the host writes for it can be reproduced by re-running this
> sitting.
>
> Leg 1 below stays exactly as it was recorded: PASS 8/8 is what was true on
> 2026-08-21 against that day's binary, and it is not evidence about the runtime
> we ship. The re-measurement is the new case's to produce. The other legs name
> their own versions and are untouched by this.

Branch `feat/TCODE-000`, version 1.31.0. **Every leg below ran against the
PACKAGED artifact**, never `electron:dev`: the close-out wave of the same day
had to fall back to dev bundles because the packaged app could not boot a
fixture tree at all, and T10 (`794532a80`) is what unblocked this run.

## The build

Unsigned, no update feed — the owner-mandated recipe for every evidence build
this plan made (plan tracker, W-pkg row):

```bash
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false \
  NESSY_DESKTOP_UPDATE_URL='https://invalid.localhost/nessy-evidence-build-no-feed' \
  NESSY_DESKTOP_UPDATE_CHANNEL=dev \
  bash apps/electron/scripts/build-dmg.sh arm64
```

`BUILD_EXIT=0`. Artifacts: `NessyDesktop-1.31.0-mac-arm64.dmg` (359 448 264 B),
the matching `.zip`, and `release/mac-arm64/Nessy Desktop.app` (1.0 G). The
electron-builder line `skipped macOS application code signing  reason=, see
https://electron.build/code-signing CSC_IDENTITY_AUTO_DISCOVERY=false` is the
unsigned build confirming itself.

Every leg launched that bundle directly:

```bash
NESSY_CONFIG_DIR=<per-case config dir> \
  "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \
  --remote-debugging-port=9223 --disable-backgrounding-occluded-windows &
```

and was killed by PORT OWNER (`lsof -ti :9223 -sTCP:LISTEN`) plus
`pkill -9 -x 'Nessy Desktop'` — never a self-matching `pgrep -f`. Dark theme was
forced by the cases themselves (`ensureDarkTheme`; every leg reported
`theme: already-dark`). `release/` was deleted after the last leg, before any
`bun test`.

## T10, incidentally re-proven three times

Three different config dirs booted the packaged app to a CDP page target:
`~/nessy-cdp-elc/config` in **6 s**, an EMPTY `~/nessy-cdp-g6/config` in **4 s**
(v2 layout created: `storageLayoutVersion: 2`, one `workspaceRefs` entry,
`activeWorkspaceId: null`), and `~/nessy-cdp-skp/config` in **4 s**. The stale
g6 tree's own `config.json` was the T10 defect verbatim — `{"builtinDpMcpServers":
{"enabled":{"t-tracker":true}}}` and nothing else, so `loadStoredConfig` had no
`activeWorkspaceId` to read.

## Leg 1 — CDX-148, the packaged leg the close-out owed

`~/nessy-cdp-elc/config`, unchanged from the close-out sitting (its tree was
already rebuilt on the current layout that night).

```
  ok   the shipped codex-app-server is the pinned rust-v0.148.0 binary — darwin-arm64 sha256=26e0c83cd8d642777384103208ad660a5f1fe95ffebc1a4f022c0a031a673b6b
  ok   the case ran in a session it created
  ok   the session runs on codex-gateway — llmConnection=codex-gateway
  ok   a Codex turn completes and carries this run's codeword back — codeword=CB0E5-F71F9-3C71B-5310C
  ok   the transcript row carries the Codex wire name mcp__sources__elicit-probe__whoami
  ok   the tool RESULT carries the unfakeable marker — a server really answered — marker=nonce=7dc05493200c
  ok   the model's reply carries what the tool returned
  ok   the fixture server's OWN log records the call — log holds ["whoami"]
--- CDX-148: PASS ---
```

`"app-under-test":{"kind":"packaged", …"via":"derived from the CDP page target
url"}` — the case's own refusal to pass on a dev build is what makes this the
leg that was owed. 22 s, 8/8.

## Leg 2 — MCP-W1..3 and SKL-P1, on trees rebuilt for the current layout

Both fixture roots were rebuilt **in the order the archive's Q13 finding
requires** — the app opens an EMPTY config dir first and lays down its own v2
layout, and only then do the fixture files go in. Building the tree first is
what produced the "Nessy storage is unavailable" alert with no window in
earlier attempts, and post-T10 it is a loud exit instead of a hang.

MCP-W (`~/nessy-cdp-g6`), five steps:

1. `mv config config.old-layout-2026-08-21` — the pre-v2 tree kept, not deleted.
2. packaged app on the now-absent config dir → v2 layout created (4 s).
3. app quit, then `bun run scripts/cdp/fixtures/mcp-naming.ts` — markets, probe
   servers, `<config>/mcp.json`, and the `t-tracker` builtin flag MERGED into
   the app's own `config.json` (`storageLayoutVersion`/`workspaceRefs`/
   `activeWorkspaceId` all preserved).
4. app relaunched; through the app's OWN marketplace RPC (the recipe in
   `2026-07-30--2026-08-17-run-narratives.md`): `marketplace.addRegistry` for
   `market-a` and `market-b`, then `marketplace.install` with
   `{kind:'listing', marketplaceId, listingId, listingKind:'plugins'}` and
   `activateIn: {kind:'workspace', workspaceId}` for `cdp-echo-probe` +
   `cdp-tracker-probe` from A and `cdp-dual-probe` from BOTH. All four
   `{"ok":true,…,"state":"supported","deferred":[]}`.
5. the three gateway connections through the app's own one-click path
   (`getNessyGatewayJwt()` → `setupLlmConnection`, JWT never leaving the page):
   `pi-api-key` `pi_compat`, `claude-gateway` `claude-runtime`,
   `codex-gateway` `codex-runtime`.

**Step 5 is not optional, and the first MCP-W1 run is the evidence.** Without a
connection the app sits behind the onboarding wizard, and the case's two DOM
checks read the wizard's text instead of the page they meant:

```
  · detail-page-reason-text: (not found; page text starts: Welcome to Nessy Desktop How would you like to connect? …)
  FAIL the detail page renders the duplicate reason a user can read
  FAIL the MCP servers panel lists rows — 0 visible rows
```

Nine of eleven checks were green even then — the wizard hides the DOM, not the
mint. After the connections and a relaunch (the archive's rule: the wizard does
not exit on its own):

```
  ok   the built-in is ACTIVE under its bare name "t-tracker" — state=active name=t-tracker
  ok   the plugin copy is DISABLED, not competing for the name — state=disabled
  ok   the reason is duplicates-builtin — unavailableReason=duplicates-builtin
  ok   the detail carries capability.dedup.builtin-identity
  ok   the reason names the plugin components that went inert with the server — safeArgs.inertComponents=skill:cdp-tracker-helper
  ok   the detail page renders the duplicate reason a user can read — Duplicates a built-in server; the built-in is used
  ok   the native "my server.v2" server resolves — state=active
  ok   the native "my server.v2" server CONNECTS and lists its tool
  ok   the native "мой сервер" server resolves — state=active
  ok   the native "мой сервер" server CONNECTS and lists its tool
  ok   the MCP servers panel lists rows — 34 visible rows
--- MCP-W1: PASS ---
```

MCP-W3, same tree, no further setup:

```
  ok   the two instances come from two DIFFERENT marketplaces (they did not collapse into one plugin slot) — 2 distinct marketplaceId(s) across 2 rows
  ok   exactly one of them serves the name — 1 active, 1 stood down
  ok   the other is stood down with duplicates-endpoint — disabled/duplicates-endpoint
  ok   the stood-down copy carries capability.dedup.endpoint-identity
  ok   the surviving copy still connects and lists its tool
  ok   the stood-down copy is NOT served by the pool — status=refused reason=disabled
--- MCP-W3: PASS ---
```

SKL-P1 (`~/nessy-cdp-skp`, a DIFFERENT root — the two are not one wave): tree
built, packaged app booted on the empty config dir, `cdp-paths-probe` installed
from `<root>/market` through the same RPC, connections created, app relaunched.
**The case must be given the fixture's config dir**: `configDir()` reads the
CASE process's `NESSY_CONFIG_DIR` and otherwise answers `~/.nessy-agent`, which
is how the first attempt reported `0 registry entries carry pluginId
cdp-paths-probe` about a plugin that was installed perfectly well.
`NESSY_CDP_PORT=9223 NESSY_CONFIG_DIR=~/nessy-cdp-skp/config bun run
scripts/cdp/cases/skl-p1.ts` → `--- SKL-P1: PASS ---`, 12/12, including the one
the row exists for:

```
  ok   the gated skill keeps the parenthesized grant intact (one entry, not two fragments) — stored ["Read","Grep","Agent(cdp-paths-probe:alpha, cdp-paths-probe:beta)","mcp__session__*"]
  ok   the gated skill keeps BOTH of its paths patterns — stored ["**/*.sql","db/**/*.yaml"], declared ["**/*.sql","db/**/*.yaml"]
  ok   the control skill carries NO paths (it is the ungated positive control) — stored null
```

The `paths` ACTIVATION half stays operator-run and is **not** claimed here; the
case says so itself (`activation-half: {"automated":false, …}`).

### MCP-W2 — FAIL 14/25, and the control that says what the failure is

Run twice, same shape both times.

| arm | in the case | what it means |
| --- | --- | --- |
| Pi | tool dispatched under the minted name, then `Tool mcp__plugin_cdp-echo-probe_echo__whoami not found` | the case's single-turn shape, not the mint |
| Claude runtime | model's own TOOLS line carries `plugin_cdp-echo-probe_echo`, `mcp__my_server_v2__whoami` AND `mcp__server-ab518e32f3__whoami`; the call turn recorded no tool row and answered `TOOL-FAILED: MCP error -32601: Method 'mcp__plugin_cdp-echo-probe_echo__whoami' not found` | same class; refuted as a dispatch defect below |
| Codex runtime | `mcp__sources__plugin_cdp-echo-probe_echo__whoami` `completed`, `nonce=bad5bd28eac1` in the tool result, in the reply, and in the fixture server's OWN log | fully green end to end |

The four Codex reds are the model-self-report rows the checklist has recorded
as a detector limitation since 0.147 put MCP tools behind tool search.

**The Pi red names its own cause, verbatim, in turn one of the control:**

```
--- turn 1 tools: [{"t":"mcp__tool_search","s":"completed"},{"t":"mcp__tool_load","s":"completed"}]
--- turn 1 reply: "MCP tools loaded and available from the user's next message (not callable in this request): mcp__plugin_cdp-echo-probe_echo__whoami"
```

MCP-W2 asks the model to call the minted name in ONE turn. Since deferred MCP
became the default (T12/T15) a `tool_load` only makes the tool callable from the
user's NEXT message, so a single-turn case cannot reach it — **exactly the drift
T16 fixed for MCP-AUTH**, whose row carries the same diagnosis from the same
night.

Under the T16 two-turn shape, on the same packaged build and the same fixture,
the invariant MCP-W2 exists to protect holds on both reds:

- **Pi** — turn 2 dispatched `mcp__plugin_cdp-echo-probe_echo__whoami`, the
  server answered `plugin-echo G6PLUGIN-FEC71A93FBC9 nonce=00b4ca8f1c36`, and
  the model's reply carried it verbatim. Ground truth in the fixture server's
  own log: `{"at":1787324211146,"label":"plugin-echo","method":"tools/call","tool":"whoami","nonce":"00b4ca8f1c36"}`.
- **Claude runtime** — the tool completed in BOTH turns
  (`nonce=c2dbdd782a56`, then `nonce=860a49d14ad8`), both lines present in the
  same log. So the -32601 is not the app failing to dispatch a minted name; it
  is what that turn's model did after the case's inventory turn. Recorded as
  observed, **not** diagnosed.

One trap the control re-found: every MCP tool call is classified `mcp_mutation`
and raises an approval card that `bypassPermissions` does NOT suppress. The
first Pi control turn sat at `toolStatus: "executing"` with
`awaitingApprovalCount: 1` until a real mouse click on the card's own Allow
button released it — a probe without an approver loop underneath reads as "the
turn produced nothing".

MCP-W2 is therefore recorded **FAIL (case debt)**, the shape Q6-LIVE's row
already uses: the case needs the T12/T16 two-turn shape before its Pi and Claude
arms can be scored again.

## Leg 3 — COMPACT-LIFE (claude) and U1's window-clamp arm, on the operator profile

Under the owner's recorded grant (plan §P.9): this leg may narrow ONE model's
`contextWindow` in the real `~/.nessy-agent/config.json` through the product's
own write path, restoring it after.

**Snapshot, taken with the app not running:**

```
dafd7650eca4d5fc40488714d79c45fc18c2ec96aa3a8070810afe43955fd620  /Users/i.i.gavrikov/.nessy-agent/config.json
dafd7650eca4d5fc40488714d79c45fc18c2ec96aa3a8070810afe43955fd620  <scratchpad>/config.json.wpkg-snapshot
```

**Restore, byte-identical, with the app killed first — and it removed both
run-owned connections the case could not:**

```
=== DIRTY (before restore) ===
de618b90cd4105641a66f7efb88edb5416f0855d0729d1a649212d6afcd31213  /Users/i.i.gavrikov/.nessy-agent/config.json
2                        ← occurrences of "claude-gateway-9"
=== AFTER RESTORE ===
dafd7650eca4d5fc40488714d79c45fc18c2ec96aa3a8070810afe43955fd620  /Users/i.i.gavrikov/.nessy-agent/config.json
dafd7650eca4d5fc40488714d79c45fc18c2ec96aa3a8070810afe43955fd620  <scratchpad>/config.json.wpkg-snapshot
0                        ← occurrences of "claude-gateway-9"
-rw-------@ 1 i.i.gavrikov  staff  12549 … config.json
```

Same digest as the snapshot, same 12 549 bytes, mode 0600 preserved.

### The run — COMPACT-LIFE claude 12/13

```
  ok   the run-owned connection landed with the arm's own providerType — providerType=claude-runtime
  ok   the narrowed contextWindow reached config.json — the product path, not an env override — stored contextWindow=240000
  ok   the case ran in a session it created — fresh
  ok   the session runs on claude-gateway-92 — claude-gateway-92
  ok   the session runs on the narrowed window, so the product read the catalog entry — window=240000, expected 240000
  ok   the session reached roughly half the window — tokens=123016 against half of 240000 = 120000
  ok   manual /compact brought the context back down — 123016 → 2024
  ok   the runtime wrote its own compaction record — 0 → 1
  ok   auto-compaction fired on its own and the context came down — 201783 → 68010
  ok   the runtime recorded the automatic compaction too — 1 → 2
  ok   claude labelled the new record automatic, not manual — compactMetadata.trigger="auto" (the manual compaction in this same session carries "manual")
  ok   the trigger fired at the threshold, not early — pre-compaction 208836 against a threshold of 207000
  FAIL the run-owned connection is gone from the owner's profile — claude-gateway-92 is still listed
--- COMPACT-LIFE: FAIL ---
```

Every detector is a source the product writes for its own reasons: the
occupancy series `[57610, 79431, 101222, 123016]` → `/compact` → `2024` →
`[85598, 114642, 143689, 172739, 201783]` → auto → `68010`, and beside it the
SDK's own `compact_boundary` records, `trigger:"manual"` then `trigger:"auto"`,
`preTokens` 123 041 and 208 836, in
`…/claude-config/projects/…/ea2b6992-….jsonl`.

**The one red is the case's own cleanup, and it is now structurally unpassable.**
`deleteLlmConnection` refuses with `N session(s) and 0 automation(s) still use
"<slug>"` — a referential guard added **2026-08-17** (`764ee8662`), two days
after this case's last green run. The case creates a session ON its connection
and never deletes the session, so the guard fires on every run by construction.
On this profile it also fires for a second reason: six sessions from the
2026-08-13/15 sittings still point at `claude-gateway-91`. The `config.json`
restore above is what actually removes both connections.

### U1's live arm — answered, and our env pair wins

This is the measurement U1's tracker row left owed ("the unknown-model window
clamp vs our env pair … rides the Claude-runtime live smoke at the wave
boundary"). CLI **2.1.223** — the version stamped in the SDK's own records
(`"version":"2.1.223"`) — is the release that clamps a session on an
UNRECOGNIZED model id to an assumed context window, and every gateway model we
ship is unrecognized.

On this packaged build, for model id `tgpt/qwen35-397b-a17b-fp8`:

| what 2.1.223 could have clamped | what the product reported |
| --- | --- |
| the context window | `contextWindow: 240000` — **our catalogue entry**, not an assumed value (`ok the session runs on the narrowed window, so the product read the catalog entry`) |
| the auto-compaction threshold | `207000`, derived from that window; auto-compaction fired at `preTokens 208836`, i.e. at the threshold and not early |

So `CLAUDE_CODE_MAX_CONTEXT_TOKENS` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW` still
win over the new enforcement, and `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`
is not needed. **This is the one thing static reading could not settle** — the
assumed window's value is not resolvable out of the stripped binary — and it is
now settled by measurement.

### The first attempt, and why it is not a defect claim

The first attempt died 19 s in, on the case's own `setConnection`:

```
--- COMPACT-LIFE: FAIL (cdp-eval-threw: CodedError: pi-session-drain-failed:runtime switch (connection-cross-runtime)
```

Three controls on the same profile, same packaged app, minutes apart, all
succeeded: a fresh session → `claude-gateway`; a fresh session →
`claude-gateway-91` (the very connection that had just refused); and the
re-run below onto a newly created `claude-gateway-92`. **One occurrence, not
reproducible in three tries** — recorded as observed, not filed as a defect.
`SessionManager.ts:10913` lists what the drain refuses on (agent, foreground
owner, workflow, background shell, child, pi-process, worktree residuals) and
the CDP surface carried only the wrapper message, not the `cause`, so which
residual fired is not known.

**What it did leave behind, and this part IS real debt:** the failed attempt's
`finally` could not remove its own connection —
`cleanup: {"slug":"claude-gateway-91","deleted":false,"connectionsRemaining":12}` —
because the product refuses the delete with
`6 session(s) and 0 automation(s) still use "claude-gateway-91"`. Those six
sessions were created on **2026-08-13/15**, by the previous COMPACT-LIFE
sittings, and have pointed at that slug ever since. The case's cleanup can never
succeed while they exist, on any run that re-uses the slug. The
`NESSY_F5_SLUG_SUFFIX` knob the case documents is the workaround and is what
this run used.

## Leg 4 — what the close-out handed to the packaged wave, picked up

The close-out's tail hands over "the packaged legs of CDX-148 and the Claude/Pi
live smokes beyond what this wave exercised". CDX-148 is leg 1. The two Pi/Claude
smokes authored since — T7's own — ran on dev bundles that night, so both were
re-sat here on the shipped artifact, on `~/nessy-cdp-rts/config`.

**RTS-15 — PASS 11/11 packaged**, upgrading T7's live gate from dev bundles to
the artifact a user installs:

```
  ok   the session starts on Claude, never having been on Pi — claude-gateway
  ok   a tool row holding the build tag exists before the switch — 1 tool row(s)
  ok   the server plans a NATIVE carry into Pi — a `text` plan means the recall below measures the old tier — connection-cross-runtime / native
  ok   the durable notice records a NATIVE carry — written from the plan and corrected by the outcome — runtime_switched:anthropic:pi:{"carry":"native"}
  ok   Pi knows the tool-only build tag — the text tier drops every tool row, so this can only be the native carry — expected E1522-7D24C-C37E3-E3682
  ok   Pi knows the prose label too — expected 39A66-AB69B-70337-4246E
  ok   the build tag did not leak into a memory file
--- RTS-15: PASS ---
```

**RTS-14 — FAIL packaged, twice, and the cause is the case's own plant.** Run A
33/36, run B aborted at leg 4. Both runs reddened the same check family — the
leg-2 (Claude) tool-only fact, unknown to legs 3, 5 and 6 — and in both the model
said why in its own words: *"the command was run but the output wasn't captured
in the visible history"*.

It was not captured because **it never happened**. Ground truth, from the Claude
SDK's OWN transcript for run B's session
(`…/claude-config/projects/-Users-i-i-gavrikov-nessy-cdp-rts-project/76465c25-….jsonl`):
the tag `47EA0-FAC7D-7ACD1-88C02` occurs **0** times, and the only `tool_use`
blocks in the whole file are the two carried in from Pi:

```
['Read', 'RESULT:"build tag for stage 1: D5CD1-66B4F-9A4E0-F4105\n"', 'subagent', 'RESULT:"the build codename is A7160-A350F-9A674-EB03C"']
```

The app's own transcript agrees — run A's 60 rows carry tool rows for stages 1
(Pi `Read`), 3 (codex `Bash`), 4 (Pi `Read`) and 5 (codex `Bash`), and **none for
stage 2 or stage 6, the two Claude legs**. `workLeg` plants a tool-only fact by
asking the model to `cat` a file and reply DONE, and **asserts nothing about the
tool row**, so a leg where the model answers DONE without running anything yields
three downstream reds that read exactly like a carry regression. The carry is
fine in the same conversation: Pi's stage-1 fact reached codex two legs later,
Pi's stage-4 fact reached codex natively, and every prose label landed.

So RTS-14's reds are a **missing positive control in the case**, and the case
needs a plant assertion (a tool row exists carrying the tag) before its
tool-only checks can be scored. The T7 dev run's 36/36 is the same case with a
model that happened to comply.

**One thing RTS-14 run B did leave open**, and it is not explained by the above:
`leg 4 switch → pi: {"ok":false,"error":"HANDLER_ERROR"}` — the anchored
codex → pi leg, the path T7 built. One occurrence; run A's leg 4 succeeded
(`anchor-and-handoff`, `from: codex-runtime, to: pi`), and the CDP surface
carried only `HANDLER_ERROR` with no cause. Recorded as an open observation, not
a defect claim.

## What this wave did NOT run, and why

- **The lane-G BYO set** (`BYO-CATALOG`, `BYO-QWEN`, `CODEX-TURN`, `G3-WIRE`) —
  an operator llm-proxy sitting, named in neither the W-pkg row nor the
  close-out's packaged-wave hand-off.
- **RTS-4/9/10, AGT-4..8, CRU-1/3/5/6, CDX-ROLES, STR-2** — BLOCKED on fixtures,
  policies and logins the harness deliberately does not create. Unchanged, and
  nothing about a packaged build moves any of them.
- **PRV-N25** — explicitly outside this plan (owner: «позже»).
- **`SKL-P1`'s `paths` activation half** — operator-run by design.
- **T2's live gateway day** beyond what this wave exercised — the `message.model`
  arm and the `claude-*` window arm are that row's, not W-pkg's.

## Litter this run leaves on the operator's profile

The harness names its sessions `CDP <case> <time>` and deliberately does not
delete them; this run added the COMPACT-LIFE sessions plus two `switch-probe`
sessions. `claude-gateway-91`/`-92` are removed from `config.json` by the
restore above, which returns the profile to exactly the state it was in — six
2026-08-15 sessions pointing at a slug that does not exist.
