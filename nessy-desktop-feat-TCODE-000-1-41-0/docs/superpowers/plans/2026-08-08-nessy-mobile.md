# Nessy Mobile — native iOS/iPadOS remote client

Owner-approved direction (2026-08-08): a phone/tablet remote for the agent —
browse sessions, read streaming turns, and above all **answer permission
approvals** while the agent runs on the desktop. No agent runtime on the
device: the app is a thin client to the same WebSocket RPC server the desktop
renderer and `apps/cli` already speak.

## Source we vendor from

Upstream PR craft-ai-agents/craft-agents-oss#966 ("feat: add native iOS and
iPadOS remote client"), pinned at head `4fab98d1a45632da35f1ec0257d2b924bf58ab33`
(open, unmerged, 98 files, +10 845). Owner explicitly approved copying pieces
wholesale where it is simpler. License: Apache-2.0 (verified in the reference checkout; inbound=outbound
covers PR contributions); record source PR, SHA and license in
`apps/ios/UPSTREAM.md` at vendor time, per the adoption-scorecard rule. The PR
may keep moving — we vendor the pinned SHA and re-sync deliberately, never
implicitly.

The pinned head is checked out locally for reading at
`.references/craft-ios-pr966/apps/ios/` (a worktree of the
`.references/craft-agents-oss` clone, branch `pr-966-ios-client`); the main
reference checkout stays at v0.11.4. M0 vendors FROM that worktree.

What the PR contains, verified 2026-08-08:

- **`CraftAgentKit`** (Swift package, reusable core): `Protocol/`
  (MessageEnvelope, ProtocolCodec, ProtocolConstants, RPCChannels, WireError,
  JSONValue), `Transport/RPCTransport` (ordered event delivery, automatic
  retry, stale-client replacement, server-aligned 100 MiB frame limit),
  `Client/RPCClient+{Sessions,SessionControl,Content,Organization,Workspaces}`,
  `Auth/` (KeychainStore, ServerConnection), plus package tests.
- **`CraftAgentsApp`** (complete SwiftUI app, 34 files): onboarding
  (ServerConnectionSetupView + view model), RootView, SessionListView/-Model,
  Chat (ChatView 515 lines, ChatViewModel, MessageBubble, MarkdownText,
  ToolCallCardView, **PermissionApprovalSheet**, ModelPickerView,
  CredentialInputSheet, OfflineBannerView, SessionFiles/NotesView),
  Persistence (SessionCacheRepository — offline cache), DesignSystem theme,
  entitlements/Info.plist, `project.yml` (XcodeGen), and 5 view-model test
  files. The author validated with `swift test` + `xcodebuild … test` on a
  simulator.

## The one real risk: wire drift

Their `Protocol/` and `Models/` mirror the upstream wire AT v0.11.x. Ours has
diverged since the fork (parity wave: `statusType
'compacting'|'compaction_complete'|'retrying'`, subagent `effort`/`model` on
the runtime snapshot, task events, approvals shape, session commands …).
M1 exists to measure that drift BEFORE any UI work; nothing downstream starts
until the conformance table says what matches, what is additive (safe to
ignore on device), and what is breaking (must adapt).

Auth reality check (grounded, and CORRECTED by the 2026-08-08 triple-check):
their pairing = server URL + token into Keychain — the same shape our own
`apps/cli` uses (`--url`/`--token`). **The pairing target is the HEADLESS
server** (`nessy-server`, `packages/server` — its header says
`NESSY_SERVER_TOKEN — required bearer token for client auth`, with cleartext
warnings for non-TLS). The desktop app's EMBEDDED server showed no token gate
in the sweep — whether it can serve external clients at all is an M1 question
to answer, not an assumption; until then M2 pairs the simulator against a
locally started `nessy-server` with a token, which is exactly the `apps/cli`
contract. dp/JWT on-device, MDM, and distribution stay OWNER-DECISION rows.

Toolchain grounded on this host (2026-08-08): `xcodegen` (homebrew),
Xcode 26.2, Swift 6.2.3 — M0 is buildable as-is.

## Tasks

Status: ⬜ open · 🔄 in progress · ✅ done · ⏸ parked

| # | task | status | commit | note |
|---|---|---|---|---|
| M0 | Vendor the pinned SHA into `apps/ios/` (kit + app + project.yml), `UPSTREAM.md` with PR/SHA/license, build as-is with `swift build` / XcodeGen — no rename yet, prove it compiles first | ✅ | `feat(mobile): M0` | 91 files at `4fab98d1`, Apache-2.0 verified in the checkout's own LICENSE. `swift build` clean, **54 kit tests pass**, `xcodegen generate` + `xcodebuild -destination 'iPhone 17 Pro'` → BUILD SUCCEEDED. Nothing renamed, no deviations yet — the `UPSTREAM.md` table is empty on purpose |
| M1 | Protocol conformance table (see `apps/ios/PROTOCOL-CONFORMANCE.md`) | ✅ | `feat(mobile): M1` | **gate passed, nothing downstream blocked.** Names first: 28/30 channels match exactly; `skills:get` and `sources:get` are genuinely absent (not renamed) — and `handshake_ack.registeredChannels` is the protocol's own answer for hiding them, which also settles M4's question. Envelope identical 7/7. Two BREAKING items, both enums, both codec-side as predicted: `PermissionRequestType` (ours 9, theirs 5 — an unknown value discarded the WHOLE request, measured, so no approval sheet at all) and `PermissionMode` (theirs carried the pre-migration `safe`/`ask`/`allow-all`). Both fixed with tolerant decoding + our vocabulary. Six extra `PermissionRequest` fields now decoded, two of them behavioural. **maxPayload measured at 104 857 600 B = 100 MiB** (ws default; we set none) — aligned. **The desktop's embedded server DOES admit external tokened clients when Server Mode is on** (0.0.0.0:9100, stable token) — the plan's "no token gate" premise was wrong. 60 kit tests green, app BUILD SUCCEEDED |
| M2 | Live pairing smoke on the simulator | ✅ | `test(mobile): M2` | **all five checkpoints green on iPhone 17 Pro against a real `nessy-server`.** Paired `ws://127.0.0.1:9101` + `NESSY_SERVER_TOKEN` → Connected → workspaces loaded (`My Workspace`) → session list rendered → session created → **live streamed turn returned `MOBILE-M2-OK`** from the gateway model, server log `Chat completed via complete event`. The M1 enum fix is visible in the UI: the composer shows the **Explore** chip, the exact value that failed to decode before it. Two rig notes: a bare host normalises to `wss://` so a plain-ws LAN server needs the scheme typed explicitly (not a defect — `ws` is accepted); and a non-empty custom `NESSY_CONFIG_DIR` root is refused by the storage gate, so the token file must live outside it |
| M3 | The remote-control core, live | ✅ | `test(mobile): M3`, `fix(mobile): terminal state` | **all of it, live.** Approval from the phone unblocks the desktop turn (`respondToPermission allowed=true` → the guarded `touch` created its file). Permission-mode picker: seven modes, server saw `changedBy: user`. **Stop: real cancel** — `Cancelling processing…` + `[ClaudeAgent] Claude Code process aborted by user`, on a turn held open by an approved `sleep 90`. **Model picker**: both gateway models listed under our own connection name; switching reached the server (`model updated to: tgpt/qwen36-35b-a3b-fp8`). The last two were only reachable after the terminal-state fix — see the row below |
| M4 | Nessy branding + fit | ✅ | `feat(mobile): M4` | **Two Info.plist keys were missing and each one alone breaks a LAN client:** `NSLocalNetworkUsageDescription` (iOS 14+ cannot show the local-network prompt without it) and `NSAppTransportSecurity → NSAllowsLocalNetworking` (ATS blocks plain `ws://` to a LAN address; the exception is scoped — `wss://` still required off-network). Verified live: a `ws://10.60.3.95:9101` handshake now reaches the server and is answered at the protocol level. Name → Nessy, icon → the desktop product mark (opaque 1024×1024). **Russian: 71 keys**, and the lesson is that a `String` is not a `LocalizedStringKey` — the first fully-translated build still showed eight English strings, all of them `String`-typed; 15 call sites now use `String(localized:)`. Onboarding gained the `ws://` hint. **"Hide unsupported surfaces" was empty**: the app has no Skills/Sources screens at all — only the kit has the models |
| M5 | Hardening pass, live | ✅ | `feat(mobile): M5` | **All four, on real devices.** *Offline cache*: server killed under a live app → "Offline — showing cached sessions", cache intact, actions offered. *Background/foreground*: HOME then relaunch → reconnects on its own, banner gone. *Two devices*: an iPad paired alongside the iPhone and **the phone stayed online** — a second client does not evict the first. *iPad split view*: `NavigationSplitView` renders sidebar + detail with a toggle. **Two silent-failure fixes fell out of it**, both verified live: the connection error was recorded and shown by no view (surfacing it is what ended a long hunt — the screen then said `authFailed`), and a saved credential the server REFUSES is now deleted so the app returns to pairing instead of sitting offline on a dead token that survives reinstall |
| F14-UI | No raw dumps in the UI; capability-driven gating | ✅ | `feat(mobile): F14-UI` | Owner screenshot showed `remote(NessyAgentKit.WireError(code: …authFailed …))` verbatim. All `WireError` codes now map to localized sentences + the code in small print; unknown codes still get a sentence. **Upstream's own wording kept** where it already had one — flattening it turned two existing tests red. `registeredChannels` retained and `supportsChannel` added so surfaces revive when the server serves them; unknown reads as supported. 8 new tests |
| F14-rename | Fork-and-own rename | ✅ | `refactor(mobile): F14` | `NessyAgentKit` / `NessyMobile`, bundle id `ru.tbank.nessy.NessyMobile`. The project is **XcodeGen-generated** — `project.yml` is the source of truth, and M4's three Info.plist keys had to move into it or a regenerate would have dropped them silently. UPSTREAM.md rows keep the old names (they are history); one new row states the rename. Gate: `swift build`, 67 kit + 40 app tests, `xcodebuild`, and a live launch in both languages |
| C | Close-out (three times: after M3, after M5, after F14) | ✅ | `docs(mobile): C`, `C2`, `C3` | `docs/nessy-mobile.md` written and indexed in `docs/README.md`. **The LAN-vs-remote comparison is in it as its own section** — four options (LAN, user-run tunnel, `connectRemoteWorkspace`/A2A, hosted relay) with what each costs, and a recommendation: keep LAN, document the tunnel, and put TLS on the embedded server first, since plain `ws` on a shared network exposes the token and the whole transcript. No desktop version bump, as specified |

## Owner-decision rows (parked, not tasks)

- ✅ **Device auth beyond token pairing** — **DECIDED 2026-08-09: pairing token
  only.** Server URL plus `NESSY_SERVER_TOKEN` in the Keychain, the same
  contract `apps/cli` already uses. No dp/JWT on the device, so no corporate
  credential lands on a personal phone.
- 🔄 **Reachability** — **DECIDED 2026-08-09: LAN for this pass.** The remote
  path (`connectRemoteWorkspace`/A2A) is not built here; the owner asked for the
  options to be laid out next, so a written comparison is a deliverable of this
  pass rather than a parked row.
- ✅ **Scope of this pass — the WHOLE plan, M0–M5** (owner, 2026-08-09, late
  revision superseding the earlier M0–M3 stop). Verification happens once, after
  M5 and the second close-out.
- ⏸ **Distribution & signing** — TestFlight / enterprise MDM; CI lane
  (`xcodebuild`) and provisioning are reviewer-owned infra.
- ⏸ **Re-sync cadence with PR #966** — it is unmerged; decide whether to track
  its evolution or fork-and-own at the pinned SHA.

## Rules for this plan

- Vendored files keep upstream structure until M4 (rename churn after
  conformance, not before).
- Every deviation from the vendored source is a recorded row in `UPSTREAM.md`
  (same discipline as `vendor/opencodex`).
- Simulator evidence only counts against a RUNNING Nessy server on this host
  (headless `nessy-server` per M2, or the desktop's embedded one if M1 admits
  it); a mocked transport proves the codec, not the product.

## Rig traps this plan paid for

Each cost real time and each produced a measurement that looked like a product
defect.

- **A simulator running a Russian locale types Cyrillic.** Launching with
  `-AppleLanguages "(ru)"` switches the on-screen keyboard, so injected Latin
  text arrives as the Cyrillic letters on the same keys. Every `Invalid token`
  in this plan was that: a logging WebSocket proxy showed
  `token=["фисвуапршолдьтщзйкыегмцчня012345"]` on the wire. **Pair in English,
  then relaunch in the locale under test.**
- **`nessy-server` REFUSES a plain-`ws` network bind.** With
  `NESSY_RPC_HOST=0.0.0.0` it logs "listening", then "Shutting down..." one
  millisecond later and exits — which reads exactly like a crash, and which
  survives every attempt to detach the process, because no signal was involved.
  Use `--allow-insecure-bind` (trusted network) or set the TLS cert/key.
- **Its graceful shutdown then takes about two minutes** on a workspace with 268
  sessions, persisting them one at a time while the port stays open. A server
  that is "still listening" may already be on its way out. Reading a
  `Cold-hydrated` sweep as *startup* work is how that became a bogus "the first
  request takes minutes" finding — check whether `Shutting down` appears
  **above** it in the log.
- **`setsid` does not exist on macOS.** A launcher using it silently starts
  nothing; `python3 -c 'os.setsid()'` is the substitute that works.
- **`xcrun simctl io … sendkey` reports success and does nothing.** There is no
  way to clear a text field from the command line — uninstall the app instead.
- **A workspace picker below the fold looks like a completed flow.** Pairing
  only saves once a workspace is chosen; the picker renders under the card, so a
  screenshot of the top of the screen shows "Connected" and hides the step that
  actually persists anything.
