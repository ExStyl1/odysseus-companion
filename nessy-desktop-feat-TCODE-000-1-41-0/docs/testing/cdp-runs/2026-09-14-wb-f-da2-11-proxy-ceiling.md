# RS-43 / DA2.11 — the `sessions:command` ceiling under a proxy refusing the app's own hosts (packaged 1.38.0)

Lane WB-f, wave A2 of the dp-auth wave-2 plan. Arms driven **2026-09-14 04:25–05:10**; written up 2026-09-17 from
the run logs, which is why every number below carries the date it was taken rather than the date of this file.

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.38.0**, built from **`a40a13193`** — the artefact
the 2026-09-13 release verification drove (RS-32 PASS 8/8 on it). Never rebuilt, never removed. Port **9225**;
`--user-data-dir` and `NESSY_CONFIG_DIR` both under the lane scratchpad, created for these runs and never under `~`.
No credential was read, printed or written: the one-click card's sign-in is the app's own `dp` module reading its own
file, and this case never touches it.

## The reading being re-taken

Rig day 2026-09-12 (lane R2, packaged 1.37.0): with a proxy refusing everything but the gateway host, a run died on
`Request timeout: sessions:command (30000ms)` while the proxy's log named `as.tbank.ru` ×6 and
`devplatform.tcsbank.ru` ×3, all refused, inside the same window. C3.357 refused the prescribed remedy — exempting
those hosts — with its reason (`packages/shared/src/config/network-proxy-utils.ts` symbol `shouldBypassProxy` carries
it), and left the latency residue unlocated. DA2.11's first step is a re-drive on the close-out build.

## A premise correction, taken before the rig was built

Neither host occurs anywhere in this product. `git grep -an 'tbank\.ru' -- packages apps scripts` answered seven
lines on 2026-09-14, every one of them a maintainer e-mail address or the commit-attribution trailer, and
`as.tbank.ru` / `devplatform.tcsbank.ru` answered **zero**. They are the `dp` BINARY's own hosts. So the traffic R2
saw refused was `dp`'s, reached through the environment the app projects into its children, and locating the
contributor is a question about **what makes the app wait on a `dp` exec** — not about an app-own fetch. Every
app-own catalogue fetch is already capped (`packages/server-core/src/model-fetchers/nestor.ts` at 3 s,
`openai-compat.ts` at 3 s and 10 s).

## The instrument

RS-33's recipe step 1 names a refusing forward proxy the harness has never shipped; lane R2 wrote one and lane R7
wrote another, both outside the repo, and three readings that matter were taken through servers no reader can
inspect. `scripts/cdp/fixtures/refusing-proxy.ts` is that server, in the tree: `CONNECT` and absolute-URI both
answered 403, nothing ever forwarded, one JSONL line per refusal, and **no header read at all** — so not even a
credential LENGTH can reach a narrative through it.

`scripts/cdp/cases/rs-43.ts` drives the measurement. Each `sessions:command` is timed **inside the renderer** around
`window.electronAPI.sessionCommand`, so the number is the one the UI itself waits for and a rejection is DATA rather
than an exception that ends the run before the rest of the sequence has been measured. `getSessions` is timed beside
them as the DISCRIMINATOR — same transport, same main process, no session handler — so a slow command next to a fast
`getSessions` is a slow HANDLER and both slow together is a starved transport. The proxy's JSONL log is sliced to
each command's own window, so the answer is not "the app was slow" but "the app was slow while it was being refused
THESE hosts".

**The positive control ran first in every proxied arm**: the driver's own `curl` through the same proxy, refused
(exit 56, `CONNECT tunnel failed, response 403`) and logged, every time. Without it every empty slice below would be
equally true of a proxy that is not running.

## The arms

Nine runs reached a verdict. Four exploratory arms first (2026-09-14 04:25–04:59), then the four ALTERNATING arms the
timing claim needs (05:01–05:10, one profile, proxied → unproxied → proxied → unproxied).

### The four exploratory arms

| arm | profile | slowest `sessions:command` | `timedOutCommands` |
| --- | --- | --- | --- |
| A — unproxied | fresh, seeded by the one-click | `updateWorkingDirectory` 1001 ms | none |
| B — proxied, the seeded profile relaunched under the proxy | same profile + `networkProxy` | `updateWorkingDirectory` **4224 ms** | none |
| C — proxied from first boot, the one-click seed done UNDER the proxy | fresh | `switchRuntime` 31 ms | none |
| D — proxied, with a turn | same as C | 1650–3700 ms | none |

### The four alternating arms (the timing claim's own control)

One profile, relaunched between arms, `networkProxy` written in and removed again by the rig rather than by a flag —
the case records which arm it is in from the APP's own settings, so two runs cannot be mixed up after the fact.

| arm | 05: | proxy | load (1 m) | `getSessions` | slowest `sessions:command` | the turn's own ms | run total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 01:51 | on | 10.13 | 3 / 16 ms | `switchRuntime` 3732 ms | **17 342** | 61 s |
| A1 | 03:28 | off | 10.25 | 3 / 2 ms | `switchRuntime` 2636 ms | **3 998** | 33 s |
| B2 | 04:48 | on | 11.90 | 1370 / 86 ms | `updateWorkingDirectory` 6643 ms | **30 522** | 179 s |
| A2 | 08:46 | off | 9.91 | 6 / 43 ms | `switchRuntime` **7805 ms** | **56 889** | 102 s |

## What the arms say

**Nothing came near the ceiling, in any arm.** The slowest `sessions:command` over all nine runs is **7805 ms**
against a 30 000 ms budget — and it was measured in an **unproxied** arm. `timedOutCommands` is empty in every run.

**No app-own host was refused in any window, in any arm.** Over the whole sitting the rig proxy logged exactly three
host names: `example.com` (the lane's own control curl), `updates.invalid` (the dev update feed the packaged build
carries) and one `fonts.gstatic.com`. `as.tbank.ru` and `devplatform.tcsbank.ru` appear **zero** times — including
while the one-click card was created under the proxy in arm C, and including during every answered turn.
`hostsRefusedDuringTheTurn` is `{}` in all four alternating arms.

**The turn's duration is not a proxy cost, and the alternating arms are what proved it.** Read as a single
before/after pair, the first turn arm looked like a 7x proxy penalty: run total 431 s proxied against 58 s unproxied.
Alternated, **the direction reverses between adjacent pairs** — B1 17.3 s proxied against A1 4.0 s unproxied (proxy
apparently 4.3x), then B2 30.5 s proxied against A2 56.9 s unproxied (unproxied 1.9x SLOWER). A term that changes
sign between adjacent pairs is not the proxy; it is the live model call's own latency, which on this gateway moved
14x (4.0 s → 56.9 s) across four runs of the same prompt on the same profile within nine minutes. The 7x reading is
refuted by its own instrument, and the refutation is the finding: **a single before/after pair on this rig measures
the gateway's mood.**

**So the ceiling does not reproduce on 1.38.0, and the reason is legible rather than lucky.** The largest known
contributor — the turn's wait on the `dp` CLI session — was removed by C3.381, and with it went the only path in
these sequences that makes the app exec `dp` at all. A machine whose `~/.nessy/dp_auth_creds.json` already holds a
usable JWT never re-mints, so `dp` is never run, so its hosts are never reached, so a proxy refusing them costs
nothing. **No timeout was invented**, which is the point of locating before bounding: a number chosen against the
30 s ceiling would have been chosen against a path that no longer runs.

## The residual condition, named rather than guessed at

The arm this sitting could NOT drive is the one where a re-mint IS required — an absent or expired JWT — because
reaching it needs either `NESSY_HOME` (DA1.5) or an edit to the owner's own credential file, which the lane's rules
forbid. `grep -raoF 'NESSY_HOME' … | wc -l` over `Contents/Resources/app` of this artefact answers **0 occurrences**
(re-taken 2026-09-17; the positive control on the same rig, `NESSY_CONFIG_DIR`, answers **43**, so the probe can
see), and the bundle self-reports `1.38.0` — so DA1.5 is not in the build under test. That arm becomes drivable on
the NEXT packaged build, where
`NESSY_HOME` can point the creds store at a directory with no JWT while `dp`'s own session is untouched. Until then
the re-mint-under-a-refusing-proxy path is a **null**, recorded rather than assumed closed.

## Three rig faults worth writing down

1. **A `config.json` written from nothing blocks startup.** Creating a fresh `NESSY_CONFIG_DIR` and writing a
   `config.json` carrying only `networkProxy` produced `custom-root-reset-required` in `<config>/logs/boot.log` —
   *"Storage readiness blocked … Startup is waiting on the storage dialog"* — and from CDP that reads as
   `renderer-gone` with zero page targets, i.e. exactly the loss `scripts/cdp/lib/renderer-health.ts` was written
   for. That is the one FAIL among the nine runs, and it is the rig's, not the product's. Let the APP write its own
   `config.json` first (launch once, quit), then merge the proxy block into it.
2. **Binding the harness's own repository as the working directory raises the trust modal**, and the modal then owns
   the screen, so the next turn dies as `composer-not-focusable` with nothing in the message saying "a dialog" — the
   failure `scripts/cdp/lib/runtime-switch.ts` symbol `trustScratchProject` exists for. `rs-43.ts` now mints its own
   directory under the OS temp dir and answers the gate for it.
3. **The case took an id that was already claimed, and nothing failed.** It was born as `RS-39`; the live checklist
   has carried a row for that id since 2026-09-13 (a wave-A row about `/quota` on the two non-Pi gateway cards), with
   its File column reading "case owed". A checklist row with no case file and a case file with no checklist row are
   invisible to each other, and the harness's sitting-case block checked the PLAN for the row id and the FILENAME for
   the case id — never the checklist. Found 2026-09-17 while writing the checklist hand-back; the case is `rs-43.ts`
   now (RS-40 to RS-42 are claimed by the same wave) and `scripts/cdp/harness.test.ts` carries the guard that makes
   the collision fail: when the checklist already has a row for a case's id, that row must mention the case's own
   `meta.row`. Measured before requiring it — 38 of the 39 cases already satisfied it and the one that did not was
   this collision.

4. **A guard is not a ceiling.** In one proxied arm `switchRuntime` answered `Cannot switch connection while another
   session mutation is in flight` at 441 ms, immediately after the trust gate was answered. Recorded here because a
   reader scanning for "the command failed" would otherwise count it as a timeout.
