# Release verification 1.38.0 — 2026-09-13 (controller; the coverage-95 plan's close-out build)

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.38.0**, built from HEAD **`a40a13193` (sources identical at `0200966e1` — the two later commits are test pins`**
(dmg `release/NessyDesktop-1.38.0-mac-arm64.dmg`), unsigned dev feed (`NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev`,
channel `dev`). Runtimes inside the bundle: Claude Agent SDK 0.3.251 (`claude` self-reports 2.1.251), codex rust-v0.154.0,
Pi 0.84.4 — the three lifts of C3.380, all landed since the 1.37.0 artefact. `bun scripts/build/codex-integrity.ts`: verified — the one bundled `darwin-arm64/codex-app-server` matches the pin (sha256 `2fc48569…d235a`) and the REAL runtime gate accepts it, upstream `rust-v0.154.0`.

Port **9224**; Electron `--user-data-dir=<scratchpad>/rig-RV-1.38.0/udd`; profile `NESSY_CONFIG_DIR=<scratchpad>/rig-RV-1.38.0/config`,
created for this run and never under `~`, exported to the harness process as well as to the app. No card was seeded: RS-32 clicks
the product's own onboarding into existence.

Whole-repo regression before the build (release/ moved aside): see the close-out report (`nessy-wf-checkpoints/work/reports/2026-09-13-coverage-95-closeout-report.md`) — the single-process whole-repo run was stopped at 100 files (3.75 files/min on this rig), its 19 failing files re-run alone: 7 pass alone, 7 real regressions fixed before this build (`c68f56db0` `c52c59257` `a40a13193` `ae2c47869` + the bridge pin), 5 in triage by lane WA-r.

### RS-32 / P6.1080 — the release's own smoke on 1.38.0: **PASS 8/8**

`bun run scripts/cdp/cases/rs-32.ts`, **43 639 ms**, load 12.95 (a regression-triage lane was running its suites beside this drive). `##CDP-RESULT##` status **PASS**.

| reading | value |
| --- | --- |
| the card the click created | `pi-api-key` · *Nessy Backend (API Key)* · `pi_compat` |
| the seeded `defaultModel` | **`tgpt/deepseek-v4-flash-0731`** — the id behind the `coder` alias |
| the retired id | **absent** (`tgpt/qwen35-397b-a17b-fp8` is what 404s) |
| the FIRST turn | **answers** on the freshly seeded card — the first gateway turn on the lifted runtimes (SDK 0.3.251 / codex rust-v0.154.0 / Pi 0.84.4) |
| the negative control (retired id selected) | the host substituted `["tgpt/deepseek-v4-flash-0731"]` for the stored retired id before the call, and the transcript carries **0 info rows** about it — the same reading as on 1.37.0: the 404 is unreachable from the product's own surface, and the substitution is silent (recorded, not judged; the case's own `control-verdict` says so) |

So P6.1080's release-critical half holds on 1.38.0 as it did on 1.37.0, and it holds on a bundle whose three runtimes were all lifted after the previous artefact. What this sitting did NOT drive: every other checklist case (the 1.37.0 rig day's readings stand for the behaviours the lifts did not touch; the lift lane W19-z/W19-z2 measured the bundle-derived readings and two designed tripwires, not the live cases — C3.433/C3.434 and the RS-37 re-take are the owed live rows, carried to the integrations plan). The interceptor closure now ships `utils/debug.ts` (`c68f56db0`), confirmed present under `Contents/Resources/app/packages/shared/src/utils/debug.ts` in this artefact.
