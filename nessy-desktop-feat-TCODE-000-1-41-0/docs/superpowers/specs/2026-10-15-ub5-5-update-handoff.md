# UB5.5 result (PARTIAL — the packaged install-over-a-running-app is the END-sitting rehearsal) — update handoff: premise, upstream comparison, the runnable control readings and the sitting recipe

Row: `UB5.5 `[electron]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(H28; OQ-43.11 default (a): the controller runs the rehearsal, unsigned, in the 1.43.0 sitting; signed
confirmation stays the reviewer's). Prepared 2026-10-15 by lane L-P57a. The lane may not launch a packaged
app, so the install-over-a-running-app half is the sitting ASK; everything runnable headlessly was run.

## Premise read (our update handoff, at HEAD)

- Entry: `installUpdate()` (`apps/electron/src/main/auto-update.ts:502`) — refuses on managed policy and on
  `downloadState !== 'ready'`; sets `__isUpdating = true` (`:525`, read by `isUpdating()` `:89`); snapshots
  window state via `beforeUpdateQuitHook?.()` BEFORE `quitAndInstall` ("electron-updater destroys
  BrowserWindows between this call and before-quit firing", `:534-546`); then hands to electron-updater.
- `quit-finalizer.ts` (the whole file, 87 lines): `finalizeQuit` reports cleanup errors and quits ANYWAY
  (`:57-62` — the exact line that turns "the update silently never installed" back into "installed, and we
  know cleanup failed"); on the update path defers to electron-updater (`:69-70`) and arms a
  `UPDATE_HANDOFF_GRACE_MS = 15_000` fallback that RELAUNCHES instead of lingering half-shut-down
  (`:76-83`). The header names the upstream failure it encodes: v0.11.3 "downloaded-but-never-installed
  because quit cleanup interrupted the installer handoff".
- Managed-policy gate pinned by `apps/electron/src/main/__tests__/auto-update-managed-gate.isolated.ts`
  (refuses install with no `quitAndInstall` even when a download is staged, `:139-142`).
- Boot diagnostics sink exists for the instrument: `boot-fatal.ts:392-417` (`<config dir>/logs/boot.log`,
  stderr mirrored; electron-log transports are disabled in packaged builds, which is why this sink exists).

So the H28 failure mode already has TWO guards in our tree (report-and-quit-anyway; grace-timer relaunch).
The rehearsal asks whether they HOLD on the packaged build.

## Upstream comparison (v0.15.1)

`performQuitCleanup` (`v0.15.1:apps/electron/src/main/index.ts:1218+`): an IDEMPOTENT cleanup chain
(`quitCleanupRan` guard; flushAllSessions + sessionManager.cleanup, browserPaneManager.destroyAll,
oauthFlowStore.dispose, model-refresh stopAll, messaging dispose, power-manager cleanup) called BEFORE
`quitAndInstall` (`index.ts:1120`) and again on `before-quit` (`:1311`). Our tree reaches the same services
through `beforeUpdateQuitHook` + the quit-finalizer chain ("flush sessions, dispose the storage runtime and
the dp broker, destroy browser panes, stop model refresh, release the power blocker, release the server
lock", `quit-finalizer.ts:4-7`) — the difference is upstream runs cleanup INSIDE the install path before
the handoff, ours runs it in before-quit with the handoff armed. **Per the row: `performQuitCleanup` is
adopted ONLY on the second outcome (downloaded-but-not-installed). No code change in this row.**

## Runnable readings (2026-10-15, headless — no packaged app, no network)

- **Feed verifier self-test:** `node scripts/verify-update-feed.mjs --self-test` →
  **6/6 passed** (its own pass/fail arms, incl. sha512 mismatch → fail, builder-debug.yml rejection).
- **The same-version control's FEED half:** a local fixture at the SHIPPED version (1.42.0, mac arm64 —
  `work/l-p57a/ub5-5/release-fixture-same-version/`: `latest-arm64-mac.yml` + one artifact) verified:
  `Selected macOS arm64 update metadata: latest-arm64-mac.yml … All 1 referenced artifact(s) exist … with
  matching sha512 → macOS arm64 update feed verified`. The in-app half ("feed at the SAME version →
  electron-updater answers no update") is the sitting rehearsal's.
- **A discovery nuance the rehearsal must know (found by the fixture, not by reading):** on mac arm64 the
  verifier accepts ONLY `dev-arm64-mac.yml / dev-arm64.yml / latest-arm64-mac.yml / latest-arm64.yml` —
  a rehearsal that drops `latest-mac.yml` beside an arm64 install false-fails at DISCOVERY, before any
  version comparison. Name the file `latest-arm64-mac.yml`.

## The sitting rehearsal recipe (the ASK; OQ-43.11 (a) — controller, unsigned)

1. Read the installed app's version from BOTH sources BEFORE the rehearsal: the bundle's
   `Contents/Info.plist` (`CFBundleShortVersionString`) and the app's own About/version report — they must
   agree (a disagreement is its own finding).
2. Serve a local feed dir over plain HTTP: the fixture above, with `version:` one patch ABOVE the installed
   version and the artifact present; edit the INSTALLED bundle's `Contents/Resources/app-update.yml`
   (`url: http://127.0.0.1:<port>`, provider generic) — electron-updater reads the feed from the bundle.
3. Check-for-update → download → Install Update. Instrument: `<config dir>/logs/boot.log` + the
   `autoUpdateLog`/`[update-flow]` lines (installUpdate pre-quit, quit cleanup failed?/update in progress,
   update handoff did not complete?) and the two version sources AFTER relaunch.
4. **Outcome 1 (installed):** both post-relaunch readings read the new version and boot.log shows a clean
   boot → record; `performQuitCleanup` stays UNADOPTED (our quit-finalizer held).
5. **Outcome 2 (downloaded-but-not-installed):** the versions still read the old one and/or the
   "update handoff did not complete; relaunching instead of lingering" line fired → record, and the row
   spawns the take: adopt upstream's idempotent `performQuitCleanup` before `quitAndInstall`
   (`auto-update.ts` gains the hook body; quit-finalizer stays).
6. **The control (can fail):** repeat step 2 with `version:` at the SAME version → the app must report
   "no update" (electron-updater compares versions itself). If it offers an install for the same version,
   the feed reading is wrong — fix the rehearsal before trusting any outcome.

## Residues

- The rehearsal is UNSIGNED (OQ-43.11 (a)); signed confirmation stays the reviewer's.
- Windows/Linux arms are out of this sitting's scope (mac arm64 machine) — the verifier covers their feed
  shapes (`--platform=win/linux`), the install handoff is mac-only here.
- The 15 s grace is a constant (`UPDATE_HANDOFF_GRACE_MS`); a slow disk mid-install could in principle trip
  the relaunch fallback — if the sitting sees it, that is a finding (fallback fired while the installer
  was still writing), recorded, not assumed.
