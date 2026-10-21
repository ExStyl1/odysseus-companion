# Mobile follow-ups: findings from the M0–M3 pass, and feature adoption from Claude/Codex mobile

Owner-approved direction (2026-08-09). Two sources feed this plan: the measured
findings of the Nessy Mobile M0–M3 pass (`2026-08-08-nessy-mobile.md`), and a
feature-mining read of the official mobile offerings — Claude Code's `mobile`
and `remote-control` pages (fetched 2026-08-09 from the live corpus) and
Codex's `cloud`/`app` pages. Everything here is a candidate unit with its own
row; F1–F4 are findings-driven (fix what the pass measured), F5–F10 are
adoption candidates (features the incumbents ship that map onto our
architecture), F11 is process debt.

Claude's architecture note that frames F5–F9: their mobile app is a THIN CLIENT
to three backends (cloud sessions; Remote Control = the user's own machine,
outbound-HTTPS-only through an Anthropic relay with server-stored transcript
for cross-device sync and reconnect; Dispatch = message-a-task). Our Nessy
Mobile is the Remote Control shape without the relay: LAN ws to the user's own
server. Codex mobile is cloud-tasks-only (start/watch/review/PR from the
ChatGPT app) — no local-session driving at all, which confirms the local-remote
niche is the differentiated one.

## Units

| # | unit | source | size | note |
|---|---|---|---|---|
| F1 | **TLS on the embedded server.** Plain `ws` on a shared network exposes the pairing token and the whole transcript; `ServerConfig` already carries cert/key fields. Serve `wss` (self-signed with on-first-pair fingerprint confirmation, or a provisioned cert — decide in-unit), keep plain `ws` for loopback only. The close-out comparison names this the prerequisite for everything off-machine | pass finding | M | Priority 1. The phone-side trust flow must show the fingerprint, not silently accept |
| F2 | **`ws://` scheme UX in pairing.** A bare `host:port` normalises to `wss://` and a plain-ws LAN server surfaces as an opaque TLS error. Onboarding gets an explicit scheme choice or a clear "this server is not TLS" error with a one-tap `ws://` retry (kept honest with F1: the flow should nudge TOWARD wss) | pass finding (rig note that cost a cycle) | S | |
| F3 | **Skills/Sources screens on the EXISTING capability projection.** RE-SCOPED 2026-08-09 by the unit's own read-gate, and verified independently by the orchestrator: the Safe-capability migration did not merely remove the raw `skills:get`/`sources:get` routes — it REPLACED them with a projection that is already served to remote clients (`capabilities:getCatalog`, `getDetail`, `preview`, `summary`, `listMcpTools` — declared in `protocol/channels.ts:461+`, registered in `handlers/rpc/capabilities.ts:141`). So the planned server half would have DUPLICATED an existing projection, and the row's named FAIL (re-adding raw routes) was never the alternative. **The unit is now mobile-only**: build the Skills and Sources screens against `capabilities:*`, gated on `registeredChannels` (already plumbed by F14-UI). Absolute paths stay hidden — that cut was deliberate in the safe model | owner request 2026-08-09 + gate finding | S–M (was M) | **mobile-only now: no desktop bump, no pinning-test change.** The gate paid for itself: it turned a duplicate-the-server unit into a UI unit |
| F4 | **Reachability milestone: off-LAN access.** OWNER CONSTRAINTS 2026-08-09: **no VPN on phones, no user tunnels — prohibited**; and **internal endpoints (incl. the Nestor gateway/A2A) are VPN-only, so a phone on LTE cannot reach them either** — the ride-existing-endpoint idea is dead. What remains is ONE road: **a bank-hosted rendezvous relay published through the internet-facing employee perimeter** — the same organizational class as AppHub, which proves the pattern exists (its QR/links install builds on phones WITHOUT VPN, docs even say "отключите VPN" when links misbehave). Shape: both desktop and phone connect OUTBOUND to the relay; sessions rendezvous by pairing identity; E2E encryption with a **per-pairing key carried in the QR** — that is not a corporate credential, so it is compatible with the token-only-on-device ruling. Costs that make this a real project: operating the service, availability dependency, security review for an internet-facing service. Until then: office Wi-Fi (LAN + F1 TLS) is the coverage | pass finding + owner constraints | L | ⏸ needs an explicit "we will operate a relay" decision + security review; AppHub precedent named for feasibility |
| F5 | **QR pairing.** Claude: the terminal/desktop displays a session QR, the phone scans it. Ours: desktop (Server Mode panel) and `nessy-server` startup print a QR encoding `wss://host:port` + token; the phone onboarding gains a Scan button. Kills the manual URL+token entry — the single most error-prone step we have (see F2) | Claude `remote-control` | S–M | Pairs naturally with F1/F2 in one release |
| F6 | **Push notifications to the phone.** Claude: pushes when a long task finishes or a decision is needed, plus ask-in-prompt ("notify me when tests finish"). Requires APNs infra (a push relay we host, or local-network alternatives). The VALUE half (deciding WHEN to notify) already exists — the desktop's notification events; the DELIVERY half is the open question | Claude `mobile` | L | ⏸ until owner picks a delivery mechanism; APNs needs signing/infra that is reviewer-owned |
| F7 | **Attachments from the phone → `@` file reference.** Claude: an attachment added in the app is downloaded by the local session and passed as an `@` reference. Ours: phone uploads over the existing ws (100 MiB frame budget measured), server stores into the session dir, message carries the reference — the same shape our desktop attachments already use | Claude `mobile` | M | |
| F8 | **Permission-mode ceiling from the device.** Claude deliberately refuses Bypass from the app (and Auto for Remote Control). Ours shows all seven modes from the phone (M3). Adopt the posture: the device picker excludes `bypassPermissions` (and optionally auto) unless the server says the session already runs there — a phone in a pocket must not be able to un-gate a workstation | Claude `mobile` §Limitations | S | Server-enforced, not just hidden in UI |
| F9 | **Trusted-device step-up — NOT ADOPTED (owner, 2026-08-09: "не нужно, делаем максимально просто").** Claude's beta ties remote-session access to an enrolled device plus an 18h sign-in freshness and a biometric/passkey step-up. We deliberately do not: the pairing token IS the credential, it is held in the Keychain of a device the user already unlocked, and the phone can never exceed the `auto` permission ceiling (F8) no matter who holds it. Adding an enrollment registry and a Face ID gate would buy a second factor on top of a device factor and cost a whole subsystem. Recorded, not scheduled — reopen only if a corporate posture review asks for it | Claude `remote-control` §Trusted Devices | ➖ | Simplicity is the decision, not an omission |
| F10 | **Delegate-a-task surface.** Codex mobile's whole model (and Claude's Dispatch): message a task from the phone, review the result later. Ours: the phone composes a task into a NEW background session on the desktop (we already have background sessions + R86 delivery); the phone's session list already shows it running | Codex `cloud`/`app`, Claude Dispatch | M | Candidate after F1/F5; mostly UI — the server primitives exist |
| F15 | mobile+desktop | ✅ | — | **Done, live.** Server: `awaitingApprovalCount` on the Session DTO, **derived** at read time by counting the live `pendingPermissionRequests` map — never stored, so answering elsewhere or an expiry clears it with no bookkeeping. Every DTO now leaves through one `toSessionDto` wrapper so the field cannot be present at one call site and missing at another. App: waiting sessions sort above all others (recency is the tie-break), a *Waiting for you* capsule outranks the unread dot, and the total shows on the app icon. Measured: of 255 sessions the server marked exactly the one blocked on a permission (`cb39582d=1`); the phone put it at the top with the badge, and the home screen showed **1**. 4 server tests + 3 wire tests. **Wire change → desktop version bump at close-out** | `feat(mobile): F15` || F16 | mobile | ✅ | — | **Done, live**, in the scoped-down form: the paired server is shown as `<host> · <workspace>` in a full-width line under the filter chips. No multi-server pairing built — the phone stores exactly one connection, so this is a property of the screen, not of a row. Name comes from what pairing recorded, so it matches what the user scanned or typed. **Placement was a measured fix**: in the title bar, beside five controls, the host truncated to `10.60.3…`. Verified on screen: `10.60.3.95 · My Workspace`. 88 kit tests, 49 app tests, i18n clean | `feat(mobile): F16` || F13 | **Theme system: the desktop's themes on the phone.** Owner decision 2026-08-09: better than a hard-coded dark+light pair — the desktop's themes are already TOKEN JSON files (`<config>/themes/*.json`: one-dark-pro, haze, vitesse, …), i.e. exactly the shape a theme engine consumes. Unit: teach `CraftTheme.swift` (the vendored one-file theme seam) to load a theme from that JSON token format, ship dark+light defaults in the bundle, and a Settings row listing bundled themes; stretch — fetch the server's theme list over RPC so desktop themes appear automatically. Dark stays the default | owner request 2026-08-09 | M | Dark+light first, JSON engine is the point — per-theme porting is the anti-goal |
| F14 | **No raw errors, no Craft in the UI.** Owner screenshot 2026-08-09: the reconnect banner showed `remote(CraftAgentKit.WireError(code: …authFailed, message: "Invalid token"…` verbatim. Two defects: (a) raw type dumps must never reach the user — map `WireError` codes to localized human messages (`authFailed` → "Неверный токен — проверьте токен сервера" + a field to re-enter it), with a generic localized fallback for unknown codes; (b) sweep every user-visible surface for Craft mentions. The FULL module rename is APPROVED: owner decided 2026-08-09 "форкаем навсегда" (fork-and-own; no upstream tracking). Rename CraftAgentKit → NessyAgentKit, CraftAgentsApp → NessyMobile app target, dirs/imports/project.yml; UPSTREAM.md keeps full provenance plus a "renamed on fork-and-own decision" row; the pinned reference worktree stays for archaeology | owner screenshot 2026-08-09 | S (UI half) / M (rename) | Both halves ride the current pass — fork-forever decided |
| F17 | **Unsigned iOS build job in CI — the cheap prerequisite before any AppHub access work.** There is no iOS job at all today (`grep -c xcodebuild .gitlab-ci.yml` → 0), so nothing has ever proved the `macos` runner can build this app. The runners doc says the image supports "сборка iOS/macOS в Xcode, симуляторы, подпись и деплой в TestFlight" and deliberately does NOT name the Xcode version (it points at Grafana / the `packer-macos-templates` README) — and we build locally on Xcode 26.2 / Swift 6.2.3. This job answers that question with no accounts, no secrets and no signing: build `NessyMobile` and run both suites on the `macos` tag. `.xcodeproj` is committed, so `xcodegen` on the image is not required (regenerate only if present). **Owner constraint 2026-08-09: its own job with its own rules — desktop and iOS must not be built on every pipeline.** Scope it to `changes: apps/ios/**` on branches, plus a manual escape hatch, `allow_failure: false` once it is known green | orchestrator, before-AppHub prerequisite | S | Answers the environment question before any owner time is spent on service accounts and GitOps MRs |
| F12 | **TestFlight — NOT ADOPTED (owner, 2026-08-09: "если есть AppHub — уберём TestFlight вовсе").** AppHub covers the whole employee-distribution need without VPN, Apple review, or ASC user management. The corporate TestFlight flow stays RECORDED here (GitOps bundle_ids.yml → match_install type:appstore → `macos` runner → pilot → beta_group.yml) in case an App Store / external-tester future ever reopens it, but no unit builds it | owner decision | ➖ | Research preserved; zero work scheduled |
| F11 | **Doc-corpus refresh + verdicts.** The live corpus is at 195 pages vs the 174 snapshot in `scripts/claude-doc-pages.tsv` (drift noticed 2026-08-09 while mining `mobile`/`remote-control`/`desktop-*`). Run the documented refresh, verdict each new row in the coverage map per the AGENTS.md rule | process debt | S–M | The new pages include exactly the surfaces this plan mines — the verdicts and this plan should agree |

## Design notes from the 2026-08-09 web pass (Codex mobile shipped our shape)

Codex added LOCAL-session mobile control in May 2026 (preview): the ChatGPT app
pairs with a running Codex on the Mac **via QR** ("no separate account, no
extra API key"), streams "screenshots, terminal output, diffs, test results,
and approval prompts … in real time", and — the detail worth copying —
**approval prompts surface as actionable cards, answerable from the lock
screen**. Mid-task model switching and a dispatch flow (new thread + context +
model from the phone) match our F10. Their users' measured pain, recorded for later: long typed replies are
cumbersome (favor tap-answers), and offline shows "last known state" (our
offline cache should SAY it is stale). Diff viewing on the phone is
DELIBERATELY OUT OF FOCUS (owner, 2026-08-09): the desktop has a diff view,
the vendored phone app has none (tool cards only), and we are not building
one now — if a phone user needs a diff, the answer is "open it on the
desktop", not a mobile diff reader. Both incumbents restrict what the phone
may do (Claude: no Bypass from the app) — F8's posture is now industry
consensus, not caution.

## TestFlight vs AppHub — the distribution decision (portals fully read 2026-08-09)

Reading the Spirit "Мобильные сборки" section changed the recommended
distribution path. There are TWO house channels, and for INTERNAL testing by
employees AppHub is strictly better than TestFlight:

**AppHub** (`build/app-hub`) — the bank's own beta-distribution service.
"Помогает установить бета-версии мобильных приложений на смартфон, **на котором
нет VPN**" — i.e. it is built for exactly our constraint (no VPN on phones).
Employees-only ("Не используйте для публикации на клиентов"). Accepts `.ipa`
and `.app`. Install = Spirit → Сборка → Мобильные сборки → pick build →
"Сгенерировать QR-код и ссылку" → scan or open link (30-day link). No Apple
Beta App Review, no external-tester ceiling, no App Store Connect user
management. This is the fastest path to "give employees the app to try".

**Distribution decision (recommended):**
- **AppHub is the primary internal channel.** Concrete steps: (1) service
  account with role **AppHub Uploader**; (2) key → env var **`APPHUB_SA_KEY_FILE`**;
  (3) a CI job from the **`.apphub`** template, or `dp apphub upload` manually;
  (4) build kind: промежуточная (≤4 недель) for dev builds, финальная (≤2 года)
  for a real release. Owner input reduces to one thing — the AppHub Uploader
  service account for our tenant — versus TestFlight's three.
- **TestFlight is DROPPED (owner, 2026-08-09)** — AppHub alone. The mapped
  TestFlight flow above is kept as a record only, for an App Store future.

The signed `.ipa` from the `ios_build` lane feeds `dp apphub upload`. Note the
signing dependency stays even without TestFlight: the distribution certificate
and profile still come from CodeSign (`match_install type:appstore`), which is
why the bundle-id GitOps MR remains step one.

Runtime reference repos found in the Spirit nav for the house pattern:
`mobile-dev-platform/app-signing-example-ios` (signing) and
`mobile-dev-platform/core-ios-template` under devplatform-templates (CI shape) —
read these before writing the lane rather than inventing it.

### AppHub corrections from apple-portal-services (repo docs read in full, 2026-08-12)

The CodeSign GitOps repo's own docs (fork:
`gitlab.tcsbank.ru/i.i.gavrikov/apple-portal-services`, cloned next to this
repo) correct two assumptions above:

- **Enterprise is dead → internal distribution is Ad Hoc.**
  `docs/enterprise_eol.md`: Apple blocked the enterprise account 2025-02-13.
  AppHub links/QR still work, but the build must be **adhoc-signed** —
  `match_install type:adhoc`, NOT `type:appstore` (that note above was
  TestFlight-era). Consequences: every target device must be registered in
  CodeSign (`dp codesign add-device --tenant nessy-desktop --acc-name
  ru.tfinance --auto`, role CodeSign Developer, up to 72 h on Apple's side);
  the account allows **100 devices/year shared across all its apps**; and the
  provisioning profile is baked into the `.ipa` at signing time, so a device
  registered after the build cannot install it until a re-signed build is
  uploaded. AppHub is an internal beta channel for registered devices, not
  "any employee scans the QR". Register testers in a batch BEFORE signing.
- **SUPERSEDED 2026-08-12 (later the same day): reviewers moved iOS to
  `ph.princess.frog-2`** — the shared internal iOS account (active, appstore
  type, holder ben.sarkisyan@tbank.ru; hosts tbooking/maia/wm internal apps).
  Identifier is now **`ph.princess.frog-2.nessy-desktop.NessyMobile`**; MR
  !867 amended to `fa493d9` (entry moved out of `ru.tfinance`, which keeps
  only the desktop). Consequences: the device registration the owner already
  did under `ru.tfinance` does NOT count — devices are per Apple account, so
  re-register with `--acc-name ph.princess.frog-2`; `fastlane/match.yml`
  gains a second team block (`ph.princess.frog-2/distribution`, adhoc);
  desktop signing under `ru.tfinance` is untouched; tenant, Uploader SA and
  `APPHUB_SA_KEY_FILE` are Spirit-side and unaffected. The paragraph below
  records the original choice for history.
- **Owner decision 2026-08-12: team `ru.tfinance`.** The same account the
  desktop already signs under (`fastlane/Fastfile`:
  `TCS_APPHUB_TEAM=ru.tfinance`, `TCS_APPHUB_MATCH_TENANT=nessy-desktop`), and
  the Distribution Signer + Credential Reader service accounts already exist
  as protected CI variables. The identifier follows the repo's documented
  prefix rule (`<account>.<tenant>.<app>`):
  **`ru.tfinance.nessy-desktop.NessyMobile`** — i.e. the app renames from
  `ru.tbank.nessy.NessyMobile` (project.yml `bundleIdPrefix`) once the
  registration MR is merged. Review may still shift it: ours would be the
  first `platform: IOS` entry in `ru.tfinance/bundle_ids.yml` (today all ~60
  are MAC_OS), so the `apphub-dev` reviewers may redirect the account choice.
- **Registration MR OPENED 2026-08-12**:
  <https://gitlab.tcsbank.ru/mobile-dev-platform/apple-portal-services/-/merge_requests/867>
  (branch `nessy-desktop-nessymobile-bundle-id`, commit `8a21c65` after a
  rebase onto upstream `ea4dacf` — the original `498b48a` is gone). Awaiting
  `apphub-dev` review; profiles regenerate 10–15 min after merge. The rebase
  also showed upstream now carries `Nessy Desktop`
  (`ru.tfinance.nessy-desktop.NessyDesktop`, MAC_OS, same tenant), so the
  tenant already has a precedent in this account; ours is still the first
  `platform: IOS` entry.
- **Remaining order:** MR merged → app-side bundle-id rename → register test
  devices → CI lane `match_install type:adhoc tenant:nessy-desktop` + `.ipa`
  export (protected vars, so the lane proves out on a protected ref) → AppHub
  Uploader SA (`APPHUB_SA_KEY_FILE`) → `.apphub` upload job or
  `dp apphub upload`.
- **Upload mechanics verified verbatim in Spirit docs 2026-08-12**
  (authenticated CDP read of `spirit-user-docs`: `docs/build/app-hub`,
  `docs/cli/apphub`, `docs/basics/service-accounts`) — role **AppHub
  Uploader**, key env **`APPHUB_SA_KEY_FILE`**, CI job from the **`.apphub`**
  template, all as recorded above. The how: a tenant **Project lead** creates
  the SA (Spirit → tenant → Управление → Сервис-аккаунты → Создать), adds the
  role, then Ключи → Добавить ключ downloads a one-time
  `ServiceAccountKeySecret` JSON (expiry chosen at creation); the docs
  themselves say to keep it in a **file-type CI variable**. CI authenticates
  via `dp auth service-acc --key-file …`. Manual `dp apphub
  upload`/`list`/`download` need NO service account — they run under
  `dp auth login` with the AppHub Uploader role granted to the person (lead
  grants it on the Пользователи page). AppHub Desktop re-sign installs
  (`--resign-available`, default true) live 7 days, max 3 apps per device,
  and lose push/Universal Links/App Extensions — the QR/link adhoc path has
  none of those limits but needs the device registered before signing.

## Explicitly not adopted

- **Cloud sessions** (Claude web / Codex cloud): a hosted execution tier is a
  different product decision entirely; our differentiated niche is local-first.
- **Channels (Telegram/Discord/iMessage), Slack**: separate integration
  surfaces, out of mobile scope.
- **Codex desktop app patterns** (projects/artifacts viewer): desktop-side
  ideas, not mobile; nothing there beats our existing session model for this
  plan's purpose.

## Sequencing recommendation

F1+F2+F5 as one security-and-pairing release (the app becomes safe and
pleasant to pair); F3 as the desktop-side unit on its own MR; F8 as a small
posture fix riding either; F7 and F10 next by owner priority; F4/F6 parked
rows with owner questions; F9 dropped as not adopted.

## Execution rules (read before starting any unit)

This plan is executed **autonomously, one unit per commit**, with the
orchestrator reviewing each commit. Owner controls direction, not each step.

**Owner override 2026-08-09: execute this plan on the existing `feature/mobile`
branch** (continue MR !41), not a fresh branch per unit. Consequence, recorded
so it is a choice and not an accident: any unit with a desktop/server half
(F1, F5, F7, F8, F10, F3) makes MR !41 touch `packages/*` too, so **that MR now
carries a desktop version bump at its close-out** — it stops being a mobile-only
artifact. Mobile-only units (F2, F13) add no such coupling. The orchestrator
flags the desktop-bump consequence at merge time.

**Release shape (owner, 2026-08-09).** The whole plan lands as ONE merge
request — MR !41 off `feature/mobile` — merged only when the executable set is
finished, not unit by unit. The branch already touches `packages/*` (TLS
server, pairing module, permission ceiling, and F15's session-summary field),
so the close-out carries a desktop version bump (1.22.0 → 1.23.0 today, rebump
if more desktop-side units land) and the full gate wave: desktop
(`typecheck:all` + `apps/cli`, lint, i18n, `bun test` with `release/` removed)
AND iOS (`swift build`, both suites, `xcodebuild`). Do NOT open a second MR to
split the desktop half — the orchestrator reviews the whole diff.

**Branch / side.** Every unit is one of three SIDES, and the side dictates
whether a desktop version bumps (the branch is now fixed to `feature/mobile` by
the override above):
- **mobile** — touches only `apps/ios/`. Continue on the Nessy-mobile branch;
  NO desktop version bump (the app is a separate artifact). Gate: `swift build`
  + both test suites + `xcodebuild` BUILD SUCCEEDED for the iPhone destination.
- **desktop** — touches `packages/*` / `apps/electron/*` (server or renderer).
  Fresh branch from `origin/master` (`feat/TCODE-000`), its own MR, **desktop
  version bump at close-out**. Gate: the AGENTS.md wire/affected-package budget;
  protocol tests on the final diff for any wire change.
- **ci** — touches `fastlane/`, `.gitlab-ci.yml`, or adds an iOS lane. Fresh
  branch; no app code; gate is a dry-run of the lane where possible.

**Mixed-side units (F1, F5, F7, F10) are TWO commits on TWO branches** — the
desktop/server half first (its own MR, version bump), the mobile half second
(referencing the server capability it consumes, feature-gated so the app still
works against an older server). Never one branch touching both trees.

**Do NOT start a ⏸ row.** ⏸ means blocked on an owner decision or input named
in its note. If a ⏸ row is otherwise ready, the executor may write the code
that does NOT need the missing input and leave the input as a clearly-marked
placeholder (e.g. the AppHub lane with `APPHUB_SA_KEY_FILE` unset), commit it as
`wip`, and stop — never invent the missing value.

**Wire-boundary units (F3, F8-server-half) are risk-triggered.** Before editing,
read the decision record named in the row; a pinning test that changes must
change toward the stated intent, never away from it. Re-adding a deliberately
removed raw route is a FAIL, not a fix.

**Dependency order that is not optional:** F14 (rename) lands first —
everything after it refers to `Nessy*` module/file names, so a unit that starts
before F14 will cite dead names (e.g. F13's theme file is `NessyTheme.swift`
AFTER the rename, `CraftTheme.swift` before). F1 (TLS) precedes F5 (the QR
encodes `wss://`) and F4 (relay assumes TLS). F2's hint half already shipped in
M4; only the typed-error half remains.

**Every deviation from vendored source stays a row in `apps/ios/UPSTREAM.md`**
with its measurement — the same discipline the M0–M5 pass held.

## Tracker

Status: ⬜ ready to execute · 🔄 in progress · ✅ done · ⏸ blocked on owner ·
➖ not adopted

| # | side | status | dep | gate / owner input | commit |
|---|---|---|---|---|---|
| F14 | mobile | ✅ | — | **Done.** UI half: every user-visible error goes through `PresentedError` (localized sentence + wire code in small print); the Craft sweep found nothing left after M4. Rename half (fork-and-own): `CraftAgentKit` → `NessyAgentKit`, `CraftAgentsApp` → `NessyMobile`, bundle id → `ru.tbank.nessy.NessyMobile`, `.xcodeproj` regenerated from `project.yml` | `b3f0f927e`, `15785c830` |
| F1 | mobile+desktop | ✅ | — | **Done, live.** A non-loopback bind with no provisioned cert now generates a self-signed one (`ensureSelfSignedCertificate`, SAN covering every local IPv4, key 0600, reused across restarts so the phone's pin stays valid, regenerated when the machine's addresses change) and the server prints its SHA-256. The phone shows the fingerprint it actually received and **gates the workspace step behind confirming it**; a pinned certificate that changes is refused, not re-asked. Loopback stays plain `ws`. Measured: server printed `8B:50:…:5A:A8`, `openssl s_client` agreed, the phone displayed the same value, and the session list loaded over `wss://10.60.3.95:9101`. 74 kit tests, 21 server transport tests | `feat(mobile): F1` |
| F2 | mobile | ✅ | F14 | **Done, live.** `secureConnectionFailed` is now its own case — "This server is not using TLS… the token and everything you send will cross the network unencrypted" — with a *Connect over ws:// anyway* button that rewrites the scheme and retries. Offered only when we dialled `wss`; NOT offered for an unreachable host or a refused token. Measured: bare `10.60.3.95:9101` → `wss` → the named error → one tap → `ws://…` → Connected. **Also fixes an F1 defect found by using it**: auto-TLS overrode `--allow-insecure-bind`, making the flag unreachable | `feat(mobile): F2` |
| F5 | mobile+desktop | ✅ | F1, F14 | **Done, live.** One payload shared by all three surfaces (`packages/shared/src/pairing/pairing-url.ts` + `PairingPayload.swift`, same vectors tested on both sides): `nessy://pair?url=…&token=…&fp=…`. `nessy-server` prints it as `NESSY_PAIRING_URL`; the desktop's Server settings render it as a QR with the `qrcode.react` already in the tree; the phone gains a **Scan pairing QR code** button and handles the same string as a link. **The fingerprint rides along**, so scanning replaces F1's manual comparison instead of adding to it — verified: pairing by link filled both fields, connected over `wss`, and the fingerprint card correctly did NOT appear. Two defects found by using it: the link first advertised the BIND address (`wss://0.0.0.0:9101`, undialable), and the handler on the pairing screen did nothing once the app was already paired. **Camera scan itself is unverifiable on a simulator** (no camera); the identical parse-and-apply path was exercised through the link | `feat(mobile): F5` |
| F8 | desktop+mobile | ✅ | — | **Done, enforced on the server and proven on the wire.** `REMOTE_CLIENT_PERMISSION_MODE_CEILING = 'auto'` (shared, ranked against `PERMISSION_MODE_ORDER`) + `isLocalClient()` — locality read from the capability set, since a phone can never honestly advertise "reveal in Finder". `setPermissionMode` throws `CAPABILITY_UNAVAILABLE` for a remote caller above the ceiling. **Measured with a hand-written client that skips our UI entirely**: `bypassPermissions` → refused with the named message; the same client setting `plan` → accepted (positive control, so the refusal is targeted, not a blanket failure). The device picker also hides it, and the code says out loud that hiding is not the enforcement. 9 named tests + 43 app tests. **Note: `docs/adr-transport-locality.md` is referenced by `capabilities.ts` and does not exist in the repo** — the capability set is the record until it does | `feat(mobile): F8` |
| F13 | mobile | ✅ | F14 | **Done, live.** `NessyTheme.swift` (renamed from `CraftTheme.swift`) is now an engine over the desktop's token format — top level is light, the `dark` object overrides. Two desktop themes bundled (`nord`, `one-dark-pro`), picker in the session-list toolbar with Dark/Light plus the theme list, dark default, choice persisted. **Adding a theme is adding a file** — the anti-goal (per-theme Swift ports) is structurally impossible. Verified on screen: picking Nord repainted the accent across the UI. **Trap found: Xcode flattens a plain group**, so `Themes/` had to become a folder reference or the engine would load nothing with no error anywhere; a test now asserts the bundle contains them and they decode. 49 app tests | `feat(mobile): F13` |
| F3 | mobile | ✅ | F14 | **Done, live against a real server.** Skills and Sources read `capabilities:getCatalog` — the projection that already existed — and the entry point is gated on `supportsChannel`, so it is absent against a server that does not serve it. Measured: 68 capabilities (skill=21, mcp=30, source=1, …); the phone rendered the real skills (find-skills, officecli, Code Review, Loop, figma-*) and the real MCP sources with `disabled` state badges. **No server change, no pinning-test change, no desktop bump** — and no paths: the model has no `content`/`body`/`path` field (asserted), and descriptions render exactly as the server sends them. 85 kit tests, 49 app tests | `feat(mobile): F3` |
| F15 | mobile+desktop | ✅ | F14 | **Done, live.** `awaitingApprovalCount` joins the Session DTO, **derived at read time** from the live pending-request map — never stored, because a second copy drifts the moment a request is answered elsewhere or expires, and a badge insisting "waiting" about a session that is not is worse than none. Every DTO now leaves through one `toSessionDto` wrapper so the field cannot be filled at one call site and forgotten at another. App: waiting sessions sort above all (recency demoted to tie-break), a *Waiting for you* capsule outranks the unread dot, workspace total on the app icon, badge permission asked only when the count is about to be non-zero. Measured against a real server: of **255 sessions** exactly the one blocked on a permission was marked | `fb39682fa` |
| F16 | mobile | ✅ | F14 | **Done, live.** The list header reads `<host> · <workspace>` — host exactly as pairing recorded it, so it matches what the user scanned or typed; workspace from the existing model. Scoped to the data as instructed: one paired connection means this belongs to the screen, not to each row, and multi-server pairing was deliberately NOT built. Placement was a measured fix — under the navigation title five toolbar controls squeezed it to `10.60.3…` | `fcd503389` |
| F7 | **mobile only** | ✅ | — | **Done, live — and like F3 the server half already existed.** `file:storeAttachment(sessionId, attachment)` already decoded base64, wrote into the session's attachments directory, generated a thumbnail and returned the reference; the phone simply never called it and always sent `storedAttachments: null`. Now it stores first and references. Measured with a phone-shaped client (no local filesystem, base64 only): `~/.nessy-agent/sessions/<ws>/6d555691…/attachments/58dc349d…_phone-shot.png` (70 B) plus `_thumb.png` (1366 B) appeared on disk. Client-side ceiling of 74 MiB, because the 100 MiB frame minus base64 inflation is the real limit. **No server change, no desktop bump.** 85 kit tests, 49 app tests | `feat(mobile): F7` |
| F10 | **mobile only** | ✅ | — | **Done, live.** A *Send a task* composer creates a session and sends the prompt in one action, without opening the chat — the third unit in a row whose server half already existed (`sessions:create` + `sessions:sendMessage`, both already registered for remote clients). Measured: the phone dispatched "Reply with the single word: dispatched.", the server logged the message and `Chat completed via complete event`, and the session appeared at the top of the phone's list ("7 sec ago") with a running indicator — the app never opened it. **No server change, no desktop bump** | `feat(mobile): F10` |
| F11 | (docs) | ✅ | — | **Done.** Corpus refreshed 174 → **185** pages; 12 new, 1 removed (`ultraplan` — kept in the map, marked deleted, since a verdict is history). Every new page verdicted: 11 ⬜ (SDK examples/troubleshooting, Claude-in-Slack, GitHub-Actions cloud providers, and the seven self-hosted-environments pages — same local-first decision as cloud sessions) and **1 🟨 `cross-session-messaging`**, which we built without reading its page: 40 files, 7 with tests, zero citations — precisely the category that cost this fork two production bugs. **Trap found: the documented refresh command strips the file's own 24-line header**, including the warning about new pages; restored, and the header now says so. 185/185 pages carry a verdict | `docs: F11` |
| F17 | ci | ✅ **run, and it answered** | — | **The `macos` runner carries Xcode 26.6 (17F113), Swift 6.3.3, macOS 26.3 arm64, iOS Simulator SDK 26.5, runtimes 17.2 / 18.2 / 18.4 / 26.2 / 26.5** — measured on job `600397425`, 2026-08-10. That is NEWER than this workstation (Xcode 26.2 / Swift 6.2.3), so the toolchain question that motivated the unit is answered and the answer is good: `NessyAgentKit` built and ran **88 tests, 1 skipped, 0 failures** on the runner, and `xcodegen` turned out to be present so the project was regenerated. `build-ios` is its own job (`changes: apps/ios/**/*` + manual), `tags: [macos]`, no `image:`, no signing and no secrets; `needs: []` after the first run showed it queued twenty minutes behind unrelated k8s stages it does not use. **One red run, and it was my bug, not the environment**: the first destination picker took the first UDID `simctl` listed — an iPhone 14 Pro on iOS 17.2, below the project's deployment target — so `xcodebuild` refused a device the runner really had. It now asks `xcodebuild -showdestinations`, the only authority on what that scheme accepts, and the failure branch says explicitly not to lower the deployment target to make it pass. **The fixed job is green in CI**: `600401531` succeeded in 91 s — app build and both suites on the runner's own simulator — so the unit is proven end to end and not merely written. It finished while `install-bun` was still queued, which is the `needs: []` change paying for itself | `ci(mobile): F17` |
| AppHub | ci | 🔄 | — | THE distribution channel (TestFlight dropped by owner). **Corrected 2026-08-12** (see §AppHub corrections): distribution is **Ad Hoc** (enterprise EOL 2025-02-13) — `match_install type:adhoc`, devices registered in CodeSign (100/year shared per account), profile baked into the `.ipa`. Owner picked team `ru.tfinance` → id `ru.tfinance.nessy-desktop.NessyMobile`, tenant `nessy-desktop`; registration MR !867 opened (branch `nessy-desktop-nessymobile-bundle-id`, `8a21c65` rebased onto upstream), awaiting `apphub-dev` review. **AppHub Uploader SA + `APPHUB_SA_KEY_FILE` DONE 2026-08-12 (owner).** **WIP lane landed** after reading the reference repos (`app-signing-example-ios` Fastfile, `pipelines/universal/utils/apphub.yml` + `hidden_jobs.md`): `fastlane ios build_adhoc` (match adhoc + gym ad-hoc export), match.yml adhoc config, CI `build-ios-adhoc` → `apphub-upload` (extends `.apphub`), both manual-only. **MR !867 MERGED 2026-08-12** (account `ph.princess.frog-2` per reviewers, id `ph.princess.frog-2.nessy-desktop.NessyMobile`). **App renamed the same day**: `bundleIdPrefix`, URL-type name, keychain service, scanner queue label; `xcodegen`; kit 88/1 skip/0 fail, app 49/0 TEST SUCCEEDED (UPSTREAM.md row records the keychain orphaning). Still needs: owner device re-registration under `ph.princess.frog-2` (the ru.tfinance one does not count), then the first protected-ref run of `build-ios-adhoc` → `apphub-upload` | wip |
| F4 | desktop+infra | ✅ | `8b443e4a7` | **Owner 2026-08-09: do it at the very end** — after the whole mobile follow-up set has landed and LAN is polished. Then still needs an explicit "we will operate a relay" decision + security review, and it expands into its OWN plan rather than a unit here (controller, backlog wave 1 wf_64beb74b-e8b, 2026-10-09; refute-by-default verifier per row, repairs where listed) (BK-2, 2026-10-09) Not adopted under the owner's rule (simplest, no new infra): an off-LAN relay would be a bank-hosted, internet-facing service. LAN + TLS stays the coverage, and the mobile page already says so (line 41 of docs-site/content/go-further/mobile.md, written in 1fccd985c). Reopen as a new infra plan if the bank decides to operate a relay. 🟨 — not adopted (owner rule), but the cited docs line (en+ru) still says off-LAN access is 'not part of this release'; reword to 'not offered' in wave 2, then close. (BK-22,, 2026-10-09; verified 2026-10-10 sound) the mobile page says access from outside the local network is not offered (LAN + the encrypted connection is the coverage), replacing "not part of this release" (en+ru) | |
| F6 | mobile+infra | ✅ | `d284d1fd7`, `a6907f6b7` | owner picks a push delivery mechanism (APNs relay is infra) (controller, backlog wave 1 wf_64beb74b-e8b, 2026-10-09; refute-by-default verifier per row, repairs where listed) (BK-2, 2026-10-09) Not adopted under the owner's rule: APNs would need a relay we host and sign. The mobile page (en+ru, d284d1fd7) now says that no push reaches the phone. It also says the waiting count on the app icon updates only while the app is open and connected to a running Nessy Desktop (SessionListView's .task calls setBadgeCount). | |
| F9 | mobile | ✅ | — | owner corporate-posture decision (device enrollment / biometric gate) CLOSED (backlog triage 2026-10-09): ➖ not adopted per the owner decision of 2026-08-09 ('не нужно, делаем максимально просто') already recorded in the row. | |
| CLOSE-OUT | both | ✅ | all ⬜ rows | **Full gate wave on the final tree, 2026-08-10.** Desktop: `typecheck:all` **0 errors**; `apps/cli` typecheck **0 errors**; `bun run lint` **0 errors, 4 warnings** (pre-existing unused eslint-disable directives); `lint:i18n:parity` **OK, 2196 keys × 1 locale**; `lint:i18n:sorted` **OK**; `bun test` after `rm -rf release` → **12 667 pass / 18 skip / 0 fail**, 6 snapshots, 48 914 assertions, 12 685 tests across 1 099 files, 418 s. iOS: `swift build` **complete**; kit **88 tests, 1 skipped, 0 failures**; app **49 tests, 0 failures**; `xcodebuild` on iPhone 17 Pro **TEST SUCCEEDED**. Release notes for 1.23.0 extended with the F15/F16 lines; version NOT re-bumped (1.23.0 unreleased). **One red run, and it was the rig, not the tree**: the first `bun test` reported 2 failures with a `nessy-server` still running against the same config dir — the documented concurrent-process trap. Stopped it and the same command returned 0 failures | `chore(release): 1.23.0 notes` |

**Ready to dispatch autonomously right now (in order):** F1 → F2 → F5 (the
security-and-pairing release), then F8, F13, F3, F7, F10, F11 by owner priority.
The ⏸ rows wait for the inputs in their gate column; the AppHub lane may be
written with placeholders and left `wip`.

**F4 is deliberately LAST (owner, 2026-08-09).** The whole set above ships
against LAN first; off-network access is the closing milestone, opened only by
an explicit owner decision and then written as its own plan. Nothing in F1–F13
assumes it — F1's TLS and F5's QR are LAN-valuable on their own, and both
happen to be the prerequisites F4 would need, so ordering it last costs
nothing and commits nothing.
