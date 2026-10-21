# Release verification 1.40.0 — 2026-09-18 (lane SIT-5a; sitting 5, two lanes in parallel)

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.40.0** (`CFBundleShortVersionString`
reads `1.40.0`), built by the controller from HEAD **`61cfc4659`**; dmg
`release/NessyDesktop-1.40.0-mac-arm64.dmg`, unsigned, dev update feed.
`bun scripts/build/codex-integrity.ts` was run by the controller against this artefact and verified.
Runtimes inside it: Claude Agent SDK 0.3.251 (the vendored `claude` self-reports **2.1.251**, and so does
`claudeCodeVersion` — the two self-reports agree), codex **`codex-app-server 0.154.0`** (its own
`--version`, read out of `Contents/Resources/app/resources/bin/codex/darwin-arm64/`), Pi **0.84.4**.

Rig, for every case below unless the case says otherwise: port **9232**; `--user-data-dir` and
`NESSY_CONFIG_DIR` both under the lane scratchpad, created for the run and never under `~`; the owner's
profile (`~/.nessy-agent`) was never launched, and `dp auth login`/`logout` were never run. The one BYO-shaped
card any case here creates carries a **fabricated** `sk-cdp-<32 hex>` key — never a real credential, never
printed. The one-click gateway cards sign in through the app's own `dp` module reading its own file, which is
the product path; this lane never read, printed or wrote that file itself. Sitting lane SIT-5b ran at the same
time on port 9242 with its own config dir; nothing of its processes, ports or profile was touched.

---

## 0. The clean-environment control, printed once per run

**The derivation re-run at HEAD, not a copied list** — the boundary-aware form (`-P`, because `git grep -E`
does not honour `\b` on this rig and the miss is silent):

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" != 0 ] && echo "$n -> $c file(s)"
  done
```

**Thirteen of thirty-one candidate names score non-zero, membership unchanged** from 2026-09-17 and from
sitting 4: `ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19, `CLAUDE_CODE_DISABLE_CRON` 12,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_CODE_SUBAGENT_MODEL` 10, `DISABLE_AUTOUPDATER` 5,
`CLAUDE_CODE_EXECPATH` 4, `CLAUDECODE` 2, `CLAUDE_CODE_OAUTH_SCOPES` 2, and four at 1
(`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_MESSAGING_TOKEN`, `MCP_CONNECTION_NONBLOCKING`).

**A rig fact about the recorded command itself, measured here.** Its `[ "$c" != 0 ]` filter is INERT on this
shell: `wc -l` pads its output, so `"       0"` is not the string `0` and every candidate prints. The command
is still right about WHICH names have readers — the numbers are the reading — but a reader who trusts the
filter will count thirty-one readers where there are thirteen. Read the numbers, not the line count.

**The app's own read-back**, through `ps eww` on the RUNNING app and never on this process:
`{"pids":8,"present":{},"controlSeen":true}` — no contaminating name, with `NESSY_CONFIG_DIR` seen in the same
read as the positive control. Eight pids because SIT-5b's four app processes were running beside this lane's
four; both lanes launched clean.

---

## 1. The rig precondition — RS-32 / P6.1080: **PASS 8/8**

Driven twice, on two profiles created for this sitting: **11 812 ms** at load 9.54 (`rig-a`) and
**37 117 ms** at load ~10 (`rig-b`, created after the rig repair in §5). Both PASS 8/8.

| reading | value |
| --- | --- |
| the card the click created | `pi-api-key` · *Nessy Backend (API Key)* · `pi_compat` |
| the seeded `defaultModel` | **`tgpt/deepseek-v4-flash-0731`** — the id behind the `coder` alias |
| the card's own catalogue | `["tgpt/deepseek-v4-flash-0731","tgpt/qwen36-35b-a3b-fp8"]` — the seed is in it |
| the retired id | **absent** |
| the FIRST turn | **answers** |

The release-critical half of P6.1080 holds on 1.40.0 as it did on 1.39.0, 1.38.0, 1.37.0 and 1.36.0.

---

## 2. D1.264's verification, which is this sitting's FIRST drive — RS-56: the defect is **FIXED**

`68bc7714f` is an ancestor of `61cfc4659` (the artefact's own commit), so the question can be put to this
build at all — read by `readArtifactMarker`'s new ancestry-only shape (D1.308), which is the shape that row
needs because its fix ships no literal: it NAMES three fields where a spread published four and adds one
string to an `exact()` list.

| reading | packaged 1.39.0 (`b1f4f279c`, sitting 4) | packaged 1.40.0 (`61cfc4659`, here) |
| --- | --- | --- |
| `getPiHarnessRuntime` BEFORE the first turn — **the control** | answers (`available:false`, `pi-runtime-not-started`, `barrierSeq:230`) | answers (`barrierSeq:48`) |
| **THE SUBJECT — after one plain turn** | **throws `pi-harness-runtime-invalid`** | **answers** (`err: null`, `pi-runtime-not-started`, `barrierSeq:61`) |
| `[data-testid="agent-panel"]` while a child runs | did **not** mount within 20 s | **mounts**, 2 rows, over 1 child record on disk |
| `listPiAgentView`, both arms | throws `pi-agent-view-invalid` | **still throws `pi-agent-view-invalid`** |

**RS-56 is 7 of 9 on 1.40.0, against 3 of 9 on 1.39.0**, and the two remaining FAILs are the second surface
rather than the subject. So the release note's *"The Pi runtime snapshot a live chat produces was rejected by
its own parser after the first turn … that is what left the agent panel dark"* **reproduces as fixed**, on
both of its halves — the parser and the panel.

**The residue is real and is a proposed row.** `listPiAgentView` throws `pi-agent-view-invalid` in BOTH arms,
including on a session that has never run a turn, exactly as it did on 1.39.0 — a WIDER statement than the
subject's and one `68bc7714f` did not touch. Sitting 4 already scored the two parsers separately for this
reason; that decision is what makes the 1.40.0 reading legible.

**And the blocking precondition D1.287 added is satisfied by the same reading**: `RTS-5` and `RTS-10` BLOCK
only when the pi-harness snapshot read THROWS, and the subject check above is precisely that read not
throwing.

---

## 3. The 1.39.0 KNOWN entries the release notes retire

### RS-44 / DA2.16 — the desktop-width model picker: **PASS 9/9**, the known issue is CLOSED

`49 536 ms` at load 11.53. On 1.39.0 this case was **FAIL 8/9**: `model-target-tool-egress` and
`model-list-provenance` occurred in `CompactModelSelector.tsx` and nowhere else, so at 1400 px the desktop
dropdown rendered neither line and a desktop user got the badge only as a hover `title`.

On 1.40.0, at 1400 px, the desktop picker's own text carries all three:

- *"This list comes from api.anthropic.com."* (provenance)
- *"This model answers from api.anthropic.com, outside Nessy Gateway. The names and schemas of your MCP tools
  are sent there with every turn."* (the egress disclosure)
- *"MCP servers outside the allowed list are not offered to this model. Your own, project and plugin servers
  are included; a short list of corporate servers still works."*

with the compact picker's own arm passing beside it and the gateway card rendering **no** disclosure in
either picker (the control that the surface does not fire on every connection). So *"The disclosure,
provenance and translated-wire lines now render in the desktop-width model picker too"* **reproduces as
fixed**.

**A rig fact this cost, worth carrying:** RS-44 wants a freshly launched renderer. Run a second and third time
in the same app instance it BLOCKED with two different sentences (*"the composer footer has no dropdown
trigger"*, then *"none of the … menus carries the integration expand toggle"*), and once FAILED with every
check passing and a click refusal as the run's error — *"compact footer dialog trigger #1 is covered by
P.mt-1 border-t …"*. Measured with `document.elementFromPoint` at each trigger's own centre: once the case
has opened the first footer dialog and pressed Escape, BOTH compact footer triggers report their covering
element as the permission-mode hint paragraph (*"Plan is the one mode a resumed session comes back in …"*)
with `pointer-events: auto`, over a 26 px footer at y=850 in a 900 px window. `88409daf7` makes the settle an
Escape plus a wait for the open-dialog count to reach zero rather than a longer sleep; a relaunch then gives
PASS 9/9 on the same bytes.

### RS-50 / DA2.26 — the quota pointer: **PASS 18/18**, and the KNOWN entry is unchanged

`238 127 ms`. All three cards — `claude-gateway`, `codex-gateway`, `pi-api-key` — answer `/quota` on at least
one surface, never let it reach the model, and treat `/quota now` as prose, each with an ordinary turn inside
RS-39's own 45 s budget as its control. That is the 1.39.0 reading (PASS 12/12) re-taken on 1.40.0 with the
third card added, and it agrees: the DISPATCH works, which is what the release notes' KNOWN entry says.

**A rig fact:** the first run of this case BLOCKED — *"the codex-gateway card could not be created through the
product's own one-click button … the app lists pi-api-key, claude-gateway"* — after pressing that button in
the same pass in which the claude one worked. The immediate re-run created it and passed. So it is a timing
reading about a fresh profile, not a product finding; a sitting that meets it should re-run before recording
anything.

### RS-43 / DA2.19 — the dp proxy and CA: **NOT RE-DRIVEN, and the premise is re-taken below**

See §7.

---

## 4. The two rows that had been NULL on two artefacts — D1.309's new cases

Both were nulled by sitting 4 for the same reason, and correctly: the 1.39.0 artefact predates the code each
asks about. On this artefact both artefact questions answer `carries`, measured in one run with the module's
own controls beside them (a marker the build does carry answers `carries`; a nonsense marker beside a nonsense
control answers `control-failed`, never an absence):

| row | marker | 1.39.0 | 1.40.0 (`61cfc4659`) |
| --- | --- | --- | --- |
| D1.244 | `sampling_params` | 0 hits, `4e3b57caf` NOT an ancestor | **3 hits**, control `context_window_size` 2, ancestor **true** |
| D1.162 | `model-catalogue-unlisted` | 0 hits, `4b2638db3` NOT an ancestor | **2 hits**, control `model-list-provenance` 1, ancestor **true** |
| D1.264 | — (ancestry only, D1.308) | `68bc7714f` NOT an ancestor | ancestor **true**, the scan not run |

The 2 for D1.162 is the number WI-aj predicted from the tree (`model-catalogue-unlisted` is in two production
components at HEAD), which is the sharpest available check that the scan reads what it claims to.

### RS-57 / D1.244 — what the gateway catalogue publishes: **PASS 6/6**, 1 304 ms

Read off `<config dir>/config.json`, the file the refresh itself writes, with the app's live record beside it.

| row | `shortName` | `reasoningEffort` | `samplingParams` | `supportsThinking` (stored) |
| --- | --- | --- | --- | --- |
| `tgpt/deepseek-v4-flash-0731` | `coder` | **`low`** | `{temperature: 1, top_p: 0.95}` | `false` |
| `tgpt/qwen36-35b-a3b-fp8` | `fast` | **none** | `{temperature: 0.7, top_k: 20, top_p: 0.8}` | `false` |

**Two controls, and the second is what makes the absence mean anything.** (1) The refresh landed:
`catalogueRefreshedAt` is written and 0 of 2 rows still carry the seed's own English sentence. (2) BOTH rows
carry `samplingParams` — the same commit and the same parser read `sampling_params` and `reasoning` — so the
`fast` row having no `reasoningEffort` is **the catalogue being silent about that model**, not the reader
being absent. That distinction is exactly what sitting 4 could not make on the 1.39.0 artefact, and it is why
that sitting's NULL was the right answer there.

The two rows DIFFER, which is the finding's own control: a build that wrote one value everywhere would be
reporting its own default rather than the catalogue's rows. The live record agrees with the persisted one.

**So D1.244's measurement exists: `coder` publishes a reasoning block (`low`), `fast` publishes none.** The
flip itself is not this lane's and was not taken — it is a `[product]` tri-state whose two rows now DISAGREE,
which by `NESSY_GATEWAY_DECLARED_TRI_STATES`' own rule drops `supportsThinking` out of that constant and moves
its derived fixtures. That is the cost the row already prices, and the owner takes it.

### RS-58 / D1.162, ledger K34 — the per-entry provenance label: **PASS 16/16**, 21 714 ms

All three states of `catalogueListed` in ONE list and ONE pass, at BOTH widths:

| state | row | DESKTOP picker | COMPACT picker |
| --- | --- | --- | --- |
| `false` (the endpoint dropped it) | `cdp-unlisted-model` | **marked "not listed"** | **marked "not listed"** |
| `true` (the endpoint confirmed it) | `cdp-listed-model` | unmarked | unmarked |
| `undefined` (nobody asked) | the card's own `DeepSeek V4 Flash` | unmarked | unmarked |
| marks on the page | — | **exactly 1 of 5 rows** | **exactly 1 of 12 rows** |

The third state is production rather than a fixture: the gateway fetcher leaves `catalogueListed` undefined on
every row it writes, and rendering that as *"not listed"* is the one thing WI-p's host half forbids. The two
probe rows are APPENDED to the card's own list through the app's own `saveLlmConnection` and the original list
is restored in a `finally` that reads it back and asserts the restore (0 probe rows left, 2 rows against 2
before).

**Three instrument faults were measured on the way and are recorded in the case rather than worked around.**
(1) The first draft created a card with a template slug and OVERWROTE the rig's own gateway card — models and
credential — then could not delete it because eleven sessions referenced it; it appends and restores now. (2)
The desktop picker's rows are Radix **menuitems**, not buttons: reading `<container> button` for both pickers
found ONE row and none of the models while the mark was on the page, which reads exactly like the 1.39.0
finding this case exists to re-take. (3) A picker row shows the model's NAME, not its id.

---

## 5. The rig repair, recorded because the reading depends on it

The first draft of RS-58 (§4) overwrote `rig-a`'s gateway card. The repair was a NEW config dir (`rig-b`)
seeded by RS-32 rather than an edit of the damaged one, so every reading after §4 is on a profile the product
created for itself.

**And the kill that did not kill, which is AGENTS.md's zsh trap in a new place:** `for p in $MINE; do kill -9
$p; done` with `MINE` a multi-line command substitution iterates ONCE over the whole string, so nothing is
killed and the old app keeps the debug port — the next launch then silently fails to bind and the next case
attaches to the OLD renderer. It presented as a fresh profile failing RS-32. Quote the expansion, or list the
pids.

---

## 6. The release-verification table on 1.40.0

| case | row | verdict | reading |
| --- | --- | --- | --- |
| RS-32 | P6.1080 | **PASS 8/8** | twice, on two fresh profiles |
| RS-44 | DA2.16 | **PASS 9/9** | the 1.39.0 known issue closed (§3) |
| RS-45 | DA2.5 | **PASS 22/22**, 21 530 ms | five pool ports, each 401 before the body parse and before the session lookup; the signature's discrimination control green |
| RS-46 | D1.14 | **FAIL 6 of 8 — and both FAILs are the ROW being closed** | `/tasks` and `/workflows` are CONSUMED by the host now: no assistant row answered either, where D1.14's premise was that the text reaches the model. The case's own detail says it: *"the host DID consume it on this build and D1.14's premise is refuted"*. The palette still offers NO row of either name, with `/help` present as the control |
| RS-47 | D1.3 | **PASS 7/7**, 43 988 ms | ships, unreachable, live if reached — unchanged from 1.39.0 |
| RS-48 | D1.13 | **PASS 7/7**, 6 703 ms | unchanged from 1.39.0 |
| RS-50 | DA2.26 | **PASS 18/18** | three cards, §3 |
| RS-49 | D1.18 | **BLOCKED on its own control**, 16 502 ms | the SDK session file the case reads was not found under the workspace's `claude-config/projects/…` — the same verdict as 1.39.0, and the case's own reading rather than a product fact |
| RS-51 | D1.21 | **PASS 8/8**, 118 488 ms | claude's own `EnterWorktree` fires in a packaged session and what it leaves behind is host-owned — unchanged from 1.39.0 |
| RS-52 | D1.27 | **PASS 17/17**, 148 497 ms | the Pi `small` tier resolves to the gateway `fast` model with the alias present and inherits the session model with it gone; the two arms DIFFER, so the alias is what decides, and the edited catalogue is restored (`["coder","fast"]`). Its own app-env read was clean over 12 pids |
| RS-55 | D1.183 | **PASS 8/8**, 75 496 ms | the codex arm reached the protected-FILE rule with the claude arm reaching the same rule as its control, both in a resolved `default` — unchanged from 1.39.0 |
| RS-56 | D1.260 / D1.264 | **7 of 9**, was 3 of 9 | the subject is FIXED; `listPiAgentView` is the residue (§2) |
| RS-57 | D1.244 | **PASS 6/6** | §4 |
| RS-58 | D1.162 | **PASS 16/16** | §4 |

---

## 7. What this sitting did NOT drive, with the premise re-taken rather than assumed

- **RS-43 / DA2.19 (the dp proxy and CA).** The 1.40.0 FIXED bullet — *"The app's network-proxy setting, and
  its extra CA with it, now reach the `dp` sign-in"* — needs the 1.39.0 sitting's own three-arm rig: a logging
  egress proxy, `NESSY_HOME` and `HOME` at empty directories, and the same proxy configured once in the app's
  `networkProxy` SETTING and once in its environment, because the finding is the DIFFERENCE between those two
  arms. That rig was not stood up here. The premise is re-taken instead: the 1.39.0 reading it is measured
  against is *"with the proxy in the app's `networkProxy` setting the re-mint SUCCEEDED and the rig proxy
  logged `as.tbank.ru` **zero** times; with the same proxy in the environment it was refused **three** times
  in 121 ms"* — so the 1.40.0 arm to drive is the SETTING one, and the discriminator is that the proxy now
  logs that host. **Owed on this artefact.**
- **RS-53, RS-54** — the two worktree rows of sitting 3. Not re-driven here.
- **D1.38 (what a branch inherits).** Re-taken from the LIVE ledger rather than re-driven: F40 reads
  `covered ʰ` (host), `partial ᵏ` (claude), `covered ʰ` (Pi) and `—` (codex, VOID — an in-workspace `touch`
  raises no card under a resolved `default`, so CONTROL 1 is vacuous there), with `rs-36.ts` as the case.
  WI-m's 1.39.0 re-run agreed with those cells. The row's own remaining source claim was re-verified at HEAD
  and HOLDS: codex has **two** production `thread/fork` call sites, not one — `CodexAgent.createRuntime` (the
  branch leg) and `CodexAgent.applySelectedPluginSkillRuntimePolicy`, which are the two symbols the F40 cell
  already names. The note's line numbers (5662, 7789) have decayed to 6524 and 9073 and are cited by symbol
  here for that reason.
- **D1.95's in-app half, D1.207 (the codex OTLP trace identity) and D1.184's switch legs.** Owed; see the
  lane report.
