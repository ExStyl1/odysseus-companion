# 2026-09-03 — W2-p, packaged 1.33.0: the build prerequisites and three live rows

Lane W2-p of wave 2 stage 2, on a quiet tree at base `01a343eba`.

**App under test:** `release/mac-arm64/Nessy Desktop.app` — built by
`NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev NESSY_DESKTOP_UPDATE_CHANNEL=dev
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64`, unsigned,
`NessyDesktop-1.33.0-mac-arm64.dmg` (352 MB). Launched with
`--remote-debugging-port=9333` against the OPERATOR config dir (`~/.nessy-agent`), no
`NESSY_IS_PACKAGED` lever — so the observer effect that lever carries is absent and no
application log was available. Every reading below therefore comes either from the artefact's own
files or from a transcript the runtime itself wrote. Dark theme confirmed on every case
(`already-dark`).

**Load while running:** 9.7–18.7 (a busy box; every case is deterministic file/transcript reading
plus real model turns, so none of the verdicts is timing-derived).

---

## P3.207 — the build itself

`bun run electron:build` runs inside `build-dmg.sh` step 7; the script also stages the Pi
subprocess, the arch-matched Claude native binary and the codex binary. Exit 0.

**One trap re-measured on the way in, and it is AGENTS.md's `&&`/pipefail entry wearing new
clothes.** The first invocation was piped into `tail -200`, so the shell reported **exit 0** for a
run that had actually failed: `⨯ cannot expand pattern "${env.NESSY_DESKTOP_UPDATE_URL}": env
NESSY_DESKTOP_UPDATE_URL is not defined`. The `.app` was already written at that point (which is
why the artefact reads still worked) but no dmg or zip existed. The variable is documented in
`README.md` / `apps/electron/README.md` for exactly this case; the second run set it and produced
the dmg. **A build driven through a pipe reports the pipe's exit code, and the last 200 lines are
not the log.**

## P3.313 — the packaged app would have shipped SDK 0.3.223

Confirmed on this tree before the fix: `apps/electron/node_modules/@anthropic-ai/` held
`claude-agent-sdk@0.3.223` (`claudeCodeVersion 2.1.223`) **and** the native binary package at the
same version, dated 21 Aug, while `bun.lock` pinned `0.3.233` / `2.1.233`. That directory is
declared in no `package.json`, so `bun install` cannot refresh it.

Two corrections to the row's own note, both measured:

1. **`build-dmg.sh` / `build-linux.sh` / `build-win.ps1` were never the leak.** All three
   `rm -rf` the nested `@anthropic-ai` directory and re-copy from the repository root before
   electron-builder runs. The leak is the six `electron:dist*` npm scripts, which run
   electron-builder directly and stage nothing.
2. **A missing `from:` path is a WARNING, not an error.** `app-builder-lib`'s `copyFiles` logs
   `file source doesn't exist` and returns, so a copy that silently did not happen looks exactly
   like a copy that did.

Fixed by pointing the core copy at `../../node_modules/@anthropic-ai/claude-agent-sdk` (the only
copy any lockfile governs) in all three platform blocks, and by making the existing `afterPack`
hook — the one seam every packaging path crosses — assert the SHIPPED version before signing.

Build log, verbatim:

```
  claude-agent-sdk 0.3.233 (claudeCodeVersion 2.1.233), native binary
  @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.233 — matches the lockfile pin.
```

The hook was exercised on seven synthetic packed trees before the build: matched core+alias
(passes), stale core (the P3.313 defect — throws), stale alias, core missing, alias missing with
the Claude stack on, alias missing with it off (passes), stale core with it off (throws). The
stale-core arm is the re-break.

## PKG-1 — PASS 9/9

`scripts/cdp/cases/pkg-1.ts`. Reads the artefact the CDP target names, then drives a Pi turn.

| Reading | Value |
| --- | --- |
| `app-under-test` | `packaged`, root `…/Nessy Desktop.app/Contents/Resources/app` |
| shipped `claude-agent-sdk` | `0.3.233`, `claudeCodeVersion 2.1.233` |
| shipped native binary | `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.233`, `claude` present |
| shipped Pi bundle | `…/Resources/app/resources/pi-agent-server/index.js`, 25 679 142 bytes |
| `import.meta.main` occurrences | 1 |
| Pi turn | answered `PKG1-<nonce>-OK` |
| Pi session file | 5 entries, 2 carrying the nonce |

**P3.291 proven on the packaged subprocess.** The guard is in the shipped bundle and the
subprocess still boots under it — the host spawns it as `<bun> --require <interceptor> index.js`,
and `import.meta.main` reads true through that form (measured separately through this package's own
`bun build --target=bun --format=esm`: the bundler emits the expression verbatim, true as
entrypoint, false when imported). The re-break: the same shipped bundle with
`if (import.meta.main)` rewritten to `if (true)` in a scratch copy — importing it starts the
server (`[pi-server] Pi agent server starting` plus a `startup_error` frame on stdout), which is
the pre-fix behaviour and is what made the row's mutant survive.

**A detector fault caught by having a second reading.** The first run asserted on
`getPiHarnessRuntime().available` after the turn settled; it reads
`available: false, reason: 'pi-runtime-not-started'` because the subprocess is torn down with the
turn — i.e. it reports "Pi never ran" about a Pi that had just answered. That snapshot is now an
observation, and the durable assertion is the Pi runtime's OWN session file carrying the nonce.

## PKG-2 — PASS 8/8 — **P3.259 REFUTED, in both arms**

`scripts/cdp/cases/pkg-2.ts`. Two throwaway projects, a nonce that exists in exactly one file on
disk, counted over the SDK child's own transcript (`<config>/workspaces/<ws>/claude-config/
projects/<…>.jsonl`).

| Arm | `CLAUDE.md` deliveries | `AGENTS.md` deliveries |
| --- | --- | --- |
| `AGENTS.md` + `CLAUDE.md` present | **1** (entry type `user`) | **1** (entry type `user`) |
| `CLAUDE.md` only | **1** (entry type `user`) | — |

The row's premise needed sharpening before it could be answered, and the first arm is what
sharpened it. `prompts/system.ts` attaches ONE project context file — first match of
`AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` — to the user-message tail; the SDK's own memory
loader reads `CLAUDE.md`, and `excludeDynamicSections: true` (`claude-agent.ts`
`buildClaudeTurnShapeOptions`) puts that on the same tail rather than in the cacheable system
prompt. So the two paths can only collide when they resolve to the SAME file, which is the
`CLAUDE.md`-only arm — the ordinary shape for anything written for Claude Code. **It does not
duplicate.**

**The instrument's honest limit:** the SDK transcript carries `user` / `assistant` / `attachment` /
`queue-operation` / `last-prompt` entries and NO system entry, so a third copy living only in the
system prompt would be invisible here. It cannot: the host's copy is documented at
`prompts/system.ts` as a user-message-tail attachment, and the SDK's is forced there by
`excludeDynamicSections`. Both counted surfaces are the ones in play.

## PKG-3 — FAIL 3/4 — **P6.29 answered, and the answer is worse than a null**

`scripts/cdp/cases/pkg-3.ts`, on `claude-gateway` (`claude-runtime`, default model
`tgpt/deepseek-v4-flash-0731`). Run twice; identical verdict both times.

| Reading | Run A | Run B |
| --- | --- | --- |
| host transcript rows | `WebSearch` ×2, `toolStatus: completed` | same |
| SDK transcript entries naming the tool | 2 | 2 |
| `toolUseResult.searchCount` | **0, 0** | **0, 0** |
| `toolUseResult.results` | one string, the upstream model's own text | same |

So `WebSearch` **is dispatched and does complete** on the claude runtime through our gateway — the
call reaches the runtime's own transcript, `is_error` is null, the row is green in the UI — and it
**performs no search**. `searchCount: 0` on every call.

What comes back in `results[0]` is the gateway model's own attempted tool call, rendered as prose:

```
I'll search for the Electron 39 release notes for you.

<｜DSML｜tool_calls>
<｜DSML｜invoke name="web_search">
<｜DSML｜parameter name="query" string="true">Electron 39 release notes</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

(run B produced the same thing in a `<search>…</search>` shape — the wrapper is whatever the
upstream model emits, not a stable format). The SDK then appends its own postscript to that
payload: *"REMINDER: You MUST include the sources above in your response to the user using markdown
hyperlinks"* — an instruction pointing at sources that do not exist.

Two findings, and they are different:

1. **`WebSearch` is declared, dispatched and useless on the gateway.** The model notices — both
   runs it said the searches came back empty and fell back to `WebFetch`, which DOES work — but
   nothing in the product says so, and the tool row reads `completed`.
2. **The fabricated result is third-party text carrying an imperative, reaching the model as a
   tool result.** It is the same hazard class as the MCP `instructions` and `hook_context` fencing
   rows (P2.236 / P3.293), on a surface no fence covers, and here the text originates from an
   upstream model rather than from a server an operator chose.

The advertisement control did not need to run (the tool executed), so the FAIL is unambiguous: it
is not "the model declined".

---

## What this run did NOT settle

- **P3.202** (codex `view_image` against a real attachment under the real profile) and **P3.57 (a)**
  (whether codex's read tool returns an image as visual content) — both need an attachment fixture
  and a codex session; not built here.
- **P3.187** (`useAutoModeDuringPlan` defaults true — what that means in a plan-mode session) —
  unmeasured.
- **P3.297** (one bundled skill handed to claude as a directory; does the native `/skill` listing
  and `context: fork` see it) — unmeasured. Note for whoever takes it: the SDK transcript this run
  read is the instrument to use, and `settingSources: ['user','project','local']` is already passed,
  so the directory route is reachable without a code change.
- **P3.246 / P3.247's non-blocking flip** — deliberately not taken; the reasoning is written into
  `mcp/server-config-values.ts`'s own docblock, which was stale in the other direction (it still
  said the change notification was unbuilt, four days after P3.246 built it).
