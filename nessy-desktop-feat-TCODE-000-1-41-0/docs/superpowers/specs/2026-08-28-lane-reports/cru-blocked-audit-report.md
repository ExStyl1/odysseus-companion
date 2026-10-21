# Recovered from the lane transcript (the lane finished without writing a report file)

These are the lane's own assistant messages in order. Narration and dead ends are
included; the findings are authoritative, the running commentary is not.

---

I'll start by reading the four case files and the checklist.

---

## Method

Read in full: the four cases, `docs/testing/cdp-live-checklist.md`, `scripts/cdp/fixtures/runtime-switch.ts`, `scripts/cdp/fixtures/paths-skill.ts`, the relevant run narratives, plus the app-side loaders. I also inspected the live operator config dir (read-only) because "is the row stale" cannot be answered from the repo alone.

---

# CRU-1 — `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/scripts/cdp/cases/cru-1.ts`

## 1. `blocked(...)` call sites

| line | verbatim reason (interpolations noted) |
|---|---|
| **443** | `'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); '` + `` `the host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}` `` — interpolation is the live `listLlmConnections()` rows. |
| **467** | `` `NESSY_CDP_CLAUDE_ASK_PROJECT=${ASK_PROJECT_DIR} is not an existing absolute path. It is compared against the ` `` + `'directory the app reports binding and against the cwd the SDK stamps on its own transcript, and neither '` + `` 'comparison survives a relative path or a `~`.' `` |
| **476** | `` `the app is asking whether to trust ${gate}. This harness does not answer that gate for a directory the ` `` + `'operator named — trusting a folder grants its instructions, skills, agents, MCP servers and hooks the '` + `'right to run. Open the folder in the app once, answer "Trust project", then re-run this case.'` — `${gate}` is the path read out of the modal. |
| **518** | **THE row's blocker.** `` `no "ask" rule names \`${ASK_PROBE_COMMAND}\`, so half (b) has nothing to measure and this harness will not ` `` + `'write one for itself — a case that installs the policy it is testing is measuring itself. '` + `` `Add it to ${scopes[0]!.file} (project scope, the file the plan's release note is about):\n` `` + `` `    { "permissions": { "ask": ["Bash(${ASK_PROBE_COMMAND})", "Bash(${ASK_PROBE_COMMAND}:*)"] } }\n` `` + `` `Then re-run with NESSY_CDP_CLAUDE_ASK_PROJECT=${projectDir}. ` `` + `` `The user scope (${scopes[2]!.file}) works too; \`~/.claude/settings.json\` does NOT — ` `` + `` 'CLAUDE_CONFIG_DIR is redirected per workspace by `agent/options.ts`. ' `` + `` `The command must be one Safe Mode auto-allows (it is compared against the read-only allowlist in ` `` + `'apps/electron/resources/permissions/default.json), or the card that appears is our own gate\'s and '` + `'proves nothing about the rule. Override the command with NESSY_CDP_CLAUDE_ASK_COMMAND.'` — `${ASK_PROBE_COMMAND}` = `NESSY_CDP_CLAUDE_ASK_COMMAND ?? 'whoami'` (line 145); `scopes[0].file` = `<projectDir>/.claude/settings.json`; `scopes[2].file` = `<config>/workspaces/<workspaceId>/claude-config/settings.json`; `${projectDir}` = `ASK_PROJECT_DIR ?? <config>/sessions/<workspaceId>/<sessionId>` (line 495). |
| **545** | `` `the read-only arm's own command \`${SAFE_PROBE_COMMAND}\` is named by ` `` + `` `${safeContamination.map(entry => `${entry.rule} (${entry.scope})`).join(', ')}, so a card on that arm would be ` `` + `'the operator\'s rule doing its job rather than Safe Mode failing. Remove the rule, or point the case at a '` + `'project whose settings do not carry one.'` — `SAFE_PROBE_COMMAND` is the literal `'echo'` (line 136). |
| **554** | `` `\`${ASK_PROBE_COMMAND}\` is also covered by a deny rule ` `` + `` `(${askProbeDenied.map(entry => `${entry.rule} (${entry.scope})`).join(', ')}). A deny refuses the call ` `` + `'without asking — "Deny and ask rules are still evaluated regardless of what the hook returns", and deny wins '` + `'over ask — so no card can appear and half (b) is unmeasurable on this command.'` |
| **631** | `` `the ask rule was read from ${askProbeRule.scope}, whose project root is ${projectDir}, but the SDK's own ` `` + `` `transcript reports cwd ${JSON.stringify(seen.cwds)}${seen.reason ? ` (${seen.reason})` : ''}. ` `` + `'Project-scope settings are resolved against the SDK\'s cwd, so that file was never loaded and half (b) '` + `'would fail for a reason that has nothing to do with the runtime. Bind the project with '` + `'NESSY_CDP_CLAUDE_ASK_PROJECT before the session\'s first turn, or move the rule to the user scope.'` |

## 2. Precondition named

A `permissions.ask` entry covering the probe command (`whoami` by default), in **one plain JSON file**, in one of three scopes the case reads at cru-1.ts:496-505:

- project: `<projectDir>/.claude/settings.json`
- local: `<projectDir>/.claude/settings.local.json`
- user: `<configDir>/workspaces/<workspaceId>/claude-config/settings.json`

Optional env: `NESSY_CDP_CLAUDE_ASK_PROJECT` (a trusted project dir), `NESSY_CDP_CLAUDE_ASK_COMMAND`.

## 5. What "the operator ask-rule fixture" actually is, and where ask-rules live

- **Nothing reads the file in our code** — the native `claude` binary does. We enable it: `packages/shared/src/agent/claude-agent.ts:1099` passes `settingSources: ['user', 'project', 'local']` (inside `buildClaudeTurnShapeOptions`, declared at `:1081`); the design note at `claude-agent.ts:850` says so explicitly ("We pass `settingSources: ['user', 'project', 'local']`, so a user's own `ask` rule is loaded and already lands here").
- **User scope path** is redirected per workspace: `packages/shared/src/agent/options.ts:259-260` (`if (workspaceConfigDir) env.CLAUDE_CONFIG_DIR = workspaceConfigDir;`) using `workspaceClaudeConfigDir()` at `options.ts:226-231`, `CLAUDE_CONFIG_DIR_NAME = 'claude-config'` at `options.ts:20`, over `getWorkspaceRootPath()` (`packages/shared/src/workspaces/paths.ts:50`) under `WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces')` (`paths.ts:8`), and `CONFIG_DIR` honours `NESSY_CONFIG_DIR` (`packages/shared/src/config/paths.ts:19-21`). So a **fixture config dir supplies the user scope directly** — that is exactly the mechanism the case's own comment describes.
- **The app already owns a writer of these files**: `addClaudePermissionRules` (`packages/shared/src/agent/claude-settings-store.ts:119`), with `claudeSettingsPath` (`:92`, `.claude/settings.json` / `settings.local.json` per `FILE_BY_DESTINATION` at `:31-35`) and `resolveClaudeSettingsRoot` (`:47`). It is an additive JSON merge — nothing exotic to reproduce.
- Both default probes are still on the shipped allowlist: `apps/electron/resources/permissions/default.json:281` `"^whoami\\b"` and `:317` `"^echo\\b"`.

## 3. Could the harness create it today?

**Technically yes — trivially.** It is a plain JSON file in a directory the fixture already owns. The established pattern is right there: `scripts/cdp/fixtures/runtime-switch.ts:194-197` writes `builtinDpMcpServers.enabled.time` straight into the fixture `config.json`, with a comment stating the doctrine — "This is a config write, which a CASE may not do … A fixture may — that is what a fixture is". `fixtures/paths-skill.ts` goes further and authors the very artifact under test (`skillFile()` at `:165`, `agentFile()` at `:191`).

Two real constraints, neither fatal:
- The **user-scope** file needs a workspace id, which only exists after the app has booted once against the fixture config dir — the same "boot once, then seed" sequence `seedConfig()` already requires (`fixtures/runtime-switch.ts:145-149`).
- The **project-scope** file needs the session bound and the folder trusted. A guarded trust-clicker exists — `trustFixtureProject` at `scripts/cdp/lib/runtime-switch.ts:322`, refusing any path but the RTS fixture's own `projectDir` (`:348`) — but CRU-1 never calls it, so today it stops at line 476.

**Live state (checked):** no `claude-config/settings.json` exists under any of the six workspaces in `~/.nessy-agent/workspaces`, and no `.claude/settings*.json` under `~/.nessy-agent/sessions`. So the BLOCKED is real today — the 2026-08-17 rule was never persisted anywhere durable.

**Classification: (b) harness-creatable today.** The only thing in the way is the case header's self-imposed rule ("It never writes the rule. A harness that installs the policy it is measuring measures itself"), which is a policy judgement, not an operator-owned resource. Worth noting the tension: by that argument SKL-P1's fixture also measures itself, and it ships.

## 8. Feature existence

Present and unchanged: `settingSources` at `claude-agent.ts:1099`; the `canUseTool` ask route and `noAlwaysAllow` reasoning documented at `claude-agent.ts:840-870`; the workspace `CLAUDE_CONFIG_DIR` redirect at `options.ts:226-260`; the read-only allowlist file with both probe patterns. Not obsolete.

---

# CRU-3 — `scripts/cdp/cases/cru-3.ts`

## 1. `blocked(...)` call sites

Plus **one outside the file that fires first**: `cru-3.ts:193` calls `requireRuntimeTrio`, which blocks at `scripts/cdp/lib/runtime-switch.ts:125`:
`` `the RTS wave needs the three gateway cards in this config dir` `` + `` (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') `` + `` (wrongRuntime.length > 0 ? `; wrong runtime: ${wrongRuntime.join('; ')}` : '') `` + `` `. Seed them with \`bun run scripts/cdp/fixtures/runtime-switch.ts\` and relaunch the packaged app` `` + `` ` with NESSY_CONFIG_DIR pointed at the fixture config dir.` `` + `` ` The app currently lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}` ``. **This is the sentence the checklist's word "fixture" points at.**

In-file:

| line | verbatim reason |
|---|---|
| **205** | `` `the Pi card "${pi.slug}" is not authenticated, so this case cannot start a session on it. ` `` + `'Sign the gateway cards in through the app (one-click dp auth) and re-run.'` |
| **211** | `` `neither "${trio.codex}" nor "${trio.claude}" is authenticated, so there is no cross-runtime target to switch TO. ` `` + `` `Authentication by slug: ${JSON.stringify(auth)}. This case needs two working runtimes.` `` |
| **237** | `` `both cards are named ${JSON.stringify(piName)}, so a row in the picker cannot be told apart by name. ` `` + `'Rename one of them in Settings → AI and re-run.'` |
| **396** | `` `the app refused to move the session onto "${slug}": ${outcome.error ?? 'unknown error'}. ` `` + `'This case needs two reachable runtimes on one host.'` |
| **403** | `` `the session did not settle on "${slug}" — it reports ${String(settled)}. The switch was accepted but never landed.` `` |
| **418** | `` `there are ${count} composer footers on screen. A multi-panel layout puts several pickers up at once and this ` `` + `'case must not guess which session it is driving — run the wave with a single content panel open.'` |
| **534** | `'the composer footer has no dropdown trigger. On a narrow layout the composer renders the COMPACT drawer '` + `'controls instead; widen the window so the desktop footer renders, then re-run.'` |
| **556** | `` `none of the ${triggers.length} composer-footer menus is the integration picker: none both names the active ` `` + `` `connection ${JSON.stringify(activeName)} and carries the integration expand toggle. The picker may be ` `` + `'disabled — it refuses to open while a turn is in flight, when the connection is unavailable, or when only '` + `'one switch target is configured.'` |
| **596** | `'the integration row vanished between identifying the picker and expanding it'` |
| **598** | `` 'the integration row is disabled, so no switch can be started. `canOpen` requires the server to report the ' `` + `'connection switchable, no turn in flight, and more than one target configured.'` |
| **618** | `` `${matches.length} rows in the integration list contain ${JSON.stringify(names.targetName)} and row ` `` + `` `#${names.targetIndex} is not one of them, so this case cannot tell which row it means. ` `` + `` `Rows: ${JSON.stringify(rows.map(r => r.text))}` `` |
| **625** | `` `the "${names.targetName}" row is disabled (not authenticated), so the picker will not offer it as a target. ` `` + `'Sign that card in through the app and re-run.'` |
| **642** | `'picking the other integration raised no dialog. Either the session lost its transcript (the silent tier), or '` + `'the picker treated this as a model change rather than a runtime change.'` |

## 2 & 6. What fixture is missing; does `runtime-switch.ts` already seed it?

**Preconditions:** three named connections — `pi-api-key` (pi), `claude-gateway` (claude-runtime), `codex-gateway` (codex-runtime) — with `isAuthenticated === true` from `listLlmConnectionsWithStatus()`; distinct card names; a single, desktop-width composer footer; a session with a transcript (the case seeds this itself, `cru-3.ts:258`). No env var, no marker file, no agent, no skill.

**Yes — `scripts/cdp/fixtures/runtime-switch.ts` already seeds exactly those three cards.** `RTS_CONNECTION_SLUGS` at `fixtures/runtime-switch.ts:106` is `['pi-api-key', 'claude-gateway', 'codex-gateway']`, copied field-by-field through the secret-free allow-list at `:125-128` by `seedConfig()` (`:145`). Authentication does not come from the fixture at all: the cards authenticate from `~/.nessy/dp_auth_creds.json`, read by the app only (header note at `:34-38`).

**Live state (checked):**
- `~/nessy-cdp-rts/config/config.json` carries all three slugs.
- The operator's own `~/.nessy-agent/config.json` also carries all three (`pi-api-key`, `claude-gateway`, `codex-gateway`), so `requireRuntimeTrio` should pass on the real profile too.
- `~/.nessy/dp_auth_creds.json` exists (452 bytes, 2026-08-21); the RTS fixture header records the JWT as valid to 2028-07-04.

**Classification: (b) — the row is stale, or at least mis-labelled.** CRU-3 PASSED on 2026-08-17 on the operator profile (`docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:496`). The 2026-08-21 close-out lists it under a blanket "BLOCKED (fixtures/env, unchanged from history)" (`docs/testing/cdp-runs/2026-08-21-1.31.0-close-out.md:82-83`) with **no case-specific reason recorded**. **I cannot determine from the repo which `blocked()` actually fired on 2026-08-21** — the plausible candidates are rig-shaped rather than fixture-shaped (line 418 multi-panel, line 534 narrow window, line 205/211/625 an expired dp JWT), none of which a fixture creates.

## 8. Feature existence

All present, and the case's copy table still matches byte-for-byte:
- `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts` — the five ids at `:140` `preToolCheck`, `:160` `worktreeMove`, `:175` `planApproval`, `:202` `appActions`, `:248` `scheduledRun`.
- `apps/electron/src/renderer/components/app-shell/input/RuntimeSwitchDialog.tsx`.
- `packages/shared/src/i18n/locales/en.json:452-457` — `costAppActions`, `costHeading`, `costPlanApproval`, `costPreToolCheck`, `costScheduledRun`, `costWorktree`; each string is identical to the case's `COST_SENTENCE` / `COST_HEADING` table. No CRU-4-style copy drift.
- `listLlmConnectionsWithStatus` still exists (`apps/electron/src/transport/channel-map.ts:437`, `apps/electron/src/shared/types.ts:947`) and `ConnectionRow.tsx` is still in the composer input folder.

---

# CRU-5 — `scripts/cdp/cases/cru-5.ts`

## 1. `blocked(...)` call sites

| line | verbatim reason |
|---|---|
| **313** | `` `the host bundle at ${symbols.path} does not carry ${symbols.missing.join(', ')}, so it predates 1e89d224f — ` `` + `'a run against it measures the code the row replaced and reports it as today\'s. '` + `` 'Rebuild (`bun run electron:build:servers`) and relaunch the app before measuring.' `` — missing symbols drawn from `R10_SYMBOLS` (`:141`). |
| **322** | **THE row's blocker.** `'this case needs an INSTALLED agent whose definition declares a skill, and it will not install one — an agent, '` + `'a skill and a plugin are the operator\'s live configuration. Set all three: '` + `` 'NESSY_CDP_SKILLED_AGENT = the name the model invokes for an agent whose frontmatter carries `skills: [<skill>]` ' `` + `'(a markdown definition in <configDir>/agents/, <project>/.nessy-agent/agents/, or a plugin-provided agent); '` + `'NESSY_CDP_SKILL_MARKER = a literal that appears ONLY inside that skill\'s body — not in the agent\'s own prompt, '` + `'not in the repository the session can read, and nothing a model could guess; '` + `'NESSY_CDP_SKILL_QUESTION = the question whose only correct answer is that marker. '` + `` `Currently: agent=${SKILLED_AGENT ?? 'unset'}, marker=${SKILL_MARKER ? 'set' : 'unset'}, question=${SKILL_QUESTION ? 'set' : 'unset'}. ` `` + `'Optionally set NESSY_CDP_PLAIN_AGENT to an installed agent that declares NO skills; without it the control '` + `` `falls back to the SDK's built-in ${BUILTIN_CONTROL_AGENT}.` `` (`BUILTIN_CONTROL_AGENT = 'general-purpose'`, `:130`). |
| **341** | `'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); this host lists '` + `` `${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}. ` `` + `'On a Pi-only host the claim is not merely unmeasured — the code path under test never runs.'` |
| **365** | `` `the control never ran: ${controlAgent} was never dispatched, so nothing establishes that an agent WITHOUT the ` `` + `'declaration cannot produce the marker. '` + `` `Dispatches seen: ${JSON.stringify(control?.calls.map(c => c.subagentType) ?? [])}. ` `` + `` `The parent said: ${JSON.stringify((control?.parentText ?? '').slice(0, 200))}.` `` |
| **377** | `` `the control is VOID: ${controlAgent}, which declares no skill, produced the marker anyway. ` `` + `'That makes the marker reachable without the declaration — most likely the child read the skill file off disk '` + `'(it has Read/Grep and the skill is a file on this machine), or the token is guessable. '` + `'Pick a marker that exists only inside the skill body and that no tool on the box can reach, then re-run. '` + `` `The control answered: ${JSON.stringify(controlAnswer.slice(0, 200))}` `` |
| **396** | `` `no agent named ${SKILLED_AGENT} is in this workspace's capability catalog, so the model would have nothing to ` `` + `` `delegate to. The catalog carries: ${rows.map(r => r.logicalName).join(', ') || 'no agents at all'}. ` `` + `'Install the agent (or correct NESSY_CDP_SKILLED_AGENT) and re-run.'` |
| **408** | `` `the agent ${SKILLED_AGENT} is in the catalog but its state is ${row.state}` `` + `` `${row.unavailableReason ? ` (${row.unavailableReason})` : ''}, so this run would measure an agent the session ` `` + `'refuses rather than one whose skills did or did not arrive.'` |
| **425** | `` `the ${SKILLED_AGENT} subagent was never dispatched, so its skills are untested. ` `` + `` `Dispatches seen: ${JSON.stringify(measured?.calls.map(c => c.subagentType) ?? [])}. ` `` + `` `The parent said: ${JSON.stringify((measured?.parentText ?? '').slice(0, 200))}. ` `` + `'Separate the two causes before reading anything into it: the model declining or answering it itself, versus '` + `` "the whole `agents` record being dropped by the CLI's all-or-nothing parse because some OTHER agent in this " `` + `'workspace is malformed. The catalog row above shows the agent is installed; it cannot show it was registered '` + `'with the SDK.'` |
| **446** | `'this run cannot score the claim: the PARENT put the marker into the subagent\'s own task input, so the child was '` + `'TOLD the answer rather than having to carry it. That is a limit of delegating through the model — the parent '` + `'composes the delegate\'s prompt. Re-run; if it recurs, use a question whose wording cannot pull the marker into '` + `'the parent\'s context first.'` |
| **462** | `` `the marker is sitting in ${leaks.map(l => `${l.scope} memory (${l.path})`).join(', ')}. Every child reads those ` `` + `'files through its own prompt, so neither arm proves anything about the agent definition. Remove the line and '` + `'re-run.'` |

## 7. What declares a subagent's skills, where it is read from, is it fixture-writable

- **Declaration**: `skills:` in the agent markdown frontmatter. Parsed at `packages/shared/src/agents/definitions.ts:555` — `const skillKeys = normalizeExplicitStringList(entry.skills, `${label}.skills`)` — with `skills` in the raw frontmatter type at `:302` and in `ARRAY_FRONTMATTER_KEYS` at `:315`.
- **Where agent files are read from**: `readMarkdownAgentDefinitionsFromDir` (`definitions.ts:747`), called by `loadAgentDefinitions` (`:818`) for `join(CONFIG_DIR, 'agents')` at **`definitions.ts:838`**, for the workspace root via `readUserAgentDefinitions` (`:798-806`), and for a **trusted** project's `<project>/.nessy-agent/agents` at **`:847`**. The catalog surface is `markdownAgentRecords(join(configDir, 'agents'), globalScope)` at `packages/shared/src/capabilities/native-sources.ts:1522`.
- **Where the skill body comes from**: `skillRecords` (`native-sources.ts:329`) over `join(configDir, 'skills')` at **`:1520`**, workspace `skills` at `:1565`, project `.nessy-agent/skills` at `:1638` / `:1336` — i.e. `<configDir>/skills/<name>/SKILL.md`.
- **Consumer under test**: `materializeClaudeRuntimeAgentSkills` (`packages/shared/src/agent/claude-runtime-agents.ts:356`), refusal literal `runtime-agent-skill-unavailable` at `:377`, folded into the agent prompt by `buildClaudeRuntimeAgents` (`:516`, `:546`), wired in at `packages/shared/src/agent/claude-agent.ts:2900`.
- **Fixture-writable?** Yes, entirely — two plain files (`<configDir>/agents/x.md`, `<configDir>/skills/y/SKILL.md`) under a `NESSY_CONFIG_DIR` the fixture owns. `fixtures/paths-skill.ts` already emits both shapes (`skillFile()` `:165`, `agentFile()` `:191`), just inside a plugin bundle; the native config-dir form is strictly simpler. Only `CONFIG_DIR` is `NESSY_CONFIG_DIR`-aware (`packages/shared/src/config/paths.ts:19-21`), which is exactly how the existing fixtures isolate themselves.

## 3. Could the harness create it today? — **and the row is stale for a second reason**

Yes. And more than that: **the artifacts already exist on this machine and were not removed**:

- `~/.nessy-agent/agents/cru-skilled.md` — frontmatter `skills: cru-house-marker`, `tools: Read, Glob, Grep`
- `~/.nessy-agent/agents/cru-plain.md` — the declared-nothing control
- `~/.nessy-agent/skills/cru-house-marker/SKILL.md` — body carries `MARKER=QUILL-VERBENA-8317`

So the 2026-08-21 BLOCKED is **not** a missing fixture; it is three unset env vars in the run invocation (`NESSY_CDP_SKILLED_AGENT=cru-skilled`, `NESSY_CDP_SKILL_MARKER=QUILL-VERBENA-8317`, `NESSY_CDP_SKILL_QUESTION=<the house-marker question>`, optional `NESSY_CDP_PLAIN_AGENT=cru-plain`). Note the marker being in git-free operator config is also what makes it a valid marker; a fixture-minted marker (paths-skill.ts's `marker()` at `:153`, read back from `markers.json`) would be the harness-generated equivalent.

**Classification: (b) harness-creatable today; the row's "fixture" note is stale.**

## 8. Feature existence

Present: `materializeClaudeRuntimeAgentSkills` (`claude-runtime-agents.ts:356`) and the string literal `runtime-agent-skill-unavailable` (`:377`) — both `R10_SYMBOLS` the case demands of the bundle. `skills:` parsing at `definitions.ts:555`. Not obsolete.

---

# CRU-6 — `scripts/cdp/cases/cru-6.ts`

## 1. `blocked(...)` call sites

| line | verbatim reason |
|---|---|
| **391** | `` `the app is asking whether to trust ${gate.path ?? PROJECT_DIR}, and this case will not answer it. Trust grants ` `` + `'project instructions, skills, agents, MCP servers, hooks and memory the right to run from that folder — for a '` + `'REAL repository that is the operator\'s decision, made in the app by hand. Grant it once, then re-run. '` + `'(While the modal is up the composer cannot be focused, so continuing would fail at the first keystroke with a '` + `'message that never mentions a dialog.)'` |
| **424** | `` `the host bundle at ${symbols.path} does not carry ${symbols.missing.join(', ')}, so it predates 0b937acb2 — ` `` + `'a run against it measures the build that dropped the declaration and reports the drop as today\'s behaviour. '` + `` 'Rebuild (`bun run electron:build:servers`) and relaunch the app before measuring.' `` — `R12_SYMBOLS = ['declares hooks in its definition']` (`:124`). |
| **433** | `'this case needs an INSTALLED agent whose definition declares worktree isolation, and it will not install one — '` + `'agents are the operator\'s live configuration. Set NESSY_CDP_ISOLATED_AGENT to the name the model invokes for '` + `` 'an agent whose frontmatter carries `isolation: worktree` (a markdown definition in <configDir>/agents/, ' `` + `'<project>/.nessy-agent/agents/, or a plugin-provided agent), and give it a tool grant that can write a file. '` + `'Optionally set NESSY_CDP_PLAIN_AGENT to an installed agent that declares NO isolation; without it the control '` + `'is the session\'s own main agent, which is a weaker but still real contrast (recorded in the result).'` |
| **444** | `` `no directory at ${PROJECT_DIR} — set NESSY_CDP_PROJECT_DIR to a real git checkout this case may write one file into` `` |
| **448** | `` `${PROJECT_DIR} is not a git working tree (${insideWorkTree.error ?? (insideWorkTree.out || 'no output')}). ` `` + `'The SDK refuses to create a worktree outside git, so an agent declaring isolation would fail to launch and '` + `'this run would score the refusal rather than the isolation.'` |
| **464** | `` `an artifact of this run's own name already exists in ${PROJECT_DIR} — refusing to measure over it` `` |
| **484** | ternary — with `NESSY_CDP_CLAUDE_CARD` set: `` `NESSY_CDP_CLAUDE_CARD names "${requestedCard}", which is not a claude-runtime connection on this host. ` `` + `` `Available: ${claudeCards.map(c => c.slug).join(', ') || 'none'}.` ``; otherwise: `'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); this host lists '` + `` `${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}. ` `` + `'The dropped field was Claude-only, so on a Pi-only host the code path under test never runs.'` |
| **547** | `` `the control never ran: ${PLAIN_AGENT} was never dispatched, so nothing establishes that a write CAN land in ` `` + `` `the checkout. Dispatches seen: ${JSON.stringify(controlArm.calls.map(c => c.subagentType))}. ` `` + `` `The parent said: ${JSON.stringify(controlArm.parentText.slice(0, 200))}.` `` |
| **554** | `` `the control is VOID: the model passed isolation "${controlArm.call.isolation}" on the Agent call itself, so the ` `` + `'control agent got a worktree too and cannot show that the checkout is writable.'` |
| **564** | `` `the control never wrote ${CONTROL_FILE} into ${PROJECT_DIR}, so this rig has not been shown to permit a write ` `` + `'into the checkout at all — and without that, "the isolated agent wrote nothing there" proves nothing. '` + `` `The control replied: ${JSON.stringify(controlArm.parentText.slice(0, 200))}` `` |
| **580** | **THE one the checklist note is about.** `` `the ${ISOLATED_AGENT} subagent was never dispatched, so its declared isolation is untested. ` `` + `` `Dispatches seen: ${JSON.stringify(isolatedArm.calls.map(c => c.subagentType))}. ` `` + `` `The parent said: ${JSON.stringify(isolatedArm.parentText.slice(0, 200))}. ` `` + `'A delegation to a DIFFERENT agent would have measured that agent\'s isolation, which is why this refuses '` + `'rather than scoring whatever ran.'` |
| **591** | `` `this run cannot score the claim: the model passed isolation "${call.isolation}" on the Agent call itself. ` `` + `` 'The call site OUTRANKS the definition in the SDK (`j = s ?? U.isolation`), so the worktree below would prove ' `` + `'the model asked for one, not that the author\'s declaration was forwarded. Re-run; the prompt already asks '` + `'for no extra arguments.'` |
| **618** | `` `${ISOLATED_FILE} is nowhere: not in ${PROJECT_DIR} and not in any other worktree of it. A write that never ` `` + `'happened is indistinguishable from an isolated one, so this run cannot score the claim. What the subagent '` + `` `returned: ${JSON.stringify(call.result.slice(0, 300))}. What the parent said: ` `` + `` `${JSON.stringify(isolatedArm.parentText.slice(0, 200))}. Two causes to separate before reading anything into ` `` + `` "it: the agent's own tool grant may not include a write tool at all, and our PreToolUse gate may have refused " `` + `'the path it tried.'` |

## 4. What "parent delegates both arms" means, and what actually stops it

Read against `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:548-600`:

- The case runs **two arms in one session**: control (`NESSY_CDP_PLAIN_AGENT`, must write into the checkout) then measured (`NESSY_CDP_ISOLATED_AGENT`, must not). Each arm delegates by *asking the parent model* to call the `Agent` tool with a specific `subagent_type` (`delegationPrompt`, `cru-6.ts:324-330`), and `runArm` only accepts a call whose `subagentType` short-name equals the agent the arm named (`:354-360`).
- **Attempt 1**: the parent dispatched the *control* agent for **both** arms — hence the note's wording. The measured arm therefore had no matching call and the case fired **line 580** rather than scoring `cru-plain`'s behaviour as `cru-isolated`'s. That refusal is the case working correctly.
- **Attempt 2** (after the control agent was given write tools): the dispatch was correct, but the subagent sat at `executing` with an empty result and never returned inside the 300 s / 240 s waits, so `runArm` again produced no `call` → **line 580** again. The narrative's conclusion: *"this is the gateway model failing to complete a delegated turn, not a mis-dispatch and not a product fault."*
- **Attempt 3** on `claude-custom-2` (Anthropic model behind `llm-proxy.t-tech.team`): every turn refused with `403 … Security Guardrail Triggered: Malicious MCP detected` listing our own `mcp__session__*` tools — the same finding the G3-WIRE row carries.

**So it is neither a fixture gap nor a defect in the isolation feature.** It is an environment/product gap: *no Claude card on this host both starts and finishes a delegated turn.* The case even documents the escape hatch (`NESSY_CDP_CLAUDE_CARD`, `cru-6.ts:478`, comment at `:470-477`). The checklist's `fixture: parent delegates both arms` is doubly misleading — it names a fixture, and it names the attempt-1 symptom that attempt 2 superseded.

## 2 & 3. Preconditions, and creatability

- `NESSY_CDP_ISOLATED_AGENT` → an agent with `isolation: worktree` + a write tool. **Exists today**: `~/.nessy-agent/agents/cru-isolated.md` (`isolation: worktree`, `tools: Read, Glob, Grep, Write, Bash`). Control `cru-plain.md` exists too. Same loader as CRU-5 (`definitions.ts:838/847`), same fixture-writability — `isolation` is parsed at `definitions.ts:565` (`normalizeIsolation`) and rejected loudly at `:584-585`.
- `PROJECT_DIR` → default hardcoded `/Users/i.i.gavrikov/Desktop/react-ui-kit` (`cru-6.ts:113`); it exists and is a git checkout. Overridable with `NESSY_CDP_PROJECT_DIR`. A fixture *could* supply a scratch git repo — `fixtures/runtime-switch.ts:202` `seedProject()` already builds one (`git init` + commit at `:216-225`) — but the case's premise is a **real** checkout plus an unanswered trust gate.
- The trust gate (line 391) is answered only by hand or by the guarded `trustFixtureProject` (`scripts/cdp/lib/runtime-switch.ts:322`, path guard at `:348`), which refuses anything but the RTS fixture project. Project trust itself is persisted at `<CONFIG_DIR>/project-trust.json` (`~/.nessy-agent/project-trust.json`, `version: 2`, keyed by opaque `projectKey`/`identityFingerprint`) — **I could not determine whether `react-ui-kit` is trusted**, because the file stores hashed keys and I did not reproduce the key derivation.

**Classification: mixed, leaning (a).** The env-var/agent-file half is (b) — already on disk, trivially fixture-creatable. The thing that actually stopped the last three sittings is (a): a working Claude runtime card whose model completes a delegated turn (operator/gateway-owned), plus the operator's own trust decision on a real repository.

## 8. Feature existence

Present:
- Forwarding: `packages/shared/src/agent/claude-runtime-agents.ts:616` — `...(descriptor.isolation ? { isolation: descriptor.isolation } : {})`, with the SDK-schema evidence at `:90-134` and the call-site-outranks-definition confound documented at `:125-129`.
- Frontmatter: `AgentDefinition.isolation` type at `definitions.ts:141`, `normalizeIsolation` used at `:565`, validation error at `:584-585`.
- The bundle date-stamp literal the case demands **does still exist**: `` `Agent "${descriptor.name}" declares hooks in its definition. ` `` at `claude-runtime-agents.ts:565`. Not obsolete.

---

# Verdict table

| Case | Classification | One-line reason |
|---|---|---|
| **CRU-1** | **(b) harness-creatable today** | The ask rule is a plain `permissions.ask` array in a JSON file under a config/project dir the fixture already owns (`options.ts:226-260`, `claude-agent.ts:1099`); the app itself has the writer (`claude-settings-store.ts:119`). Only the case header's "the harness will not write the policy it measures" rule stands in the way. Nothing exists on disk today, so the current BLOCKED is honest. |
| **CRU-3** | **(b) stale row** | Its only fixture precondition is the RTS trio, which `fixtures/runtime-switch.ts:106/145` already seeds, which `~/nessy-cdp-rts/config` already carries, and which the operator's real profile also carries. The 2026-08-21 blocked reason is unrecorded; the reachable blockers are rig-shaped (window width, panel count, dp JWT), not fixture-shaped. |
| **CRU-5** | **(b) stale row** | Agent + skill are two markdown files in `<configDir>/agents` / `<configDir>/skills` (`definitions.ts:838`, `native-sources.ts:1520`), the exact shape `paths-skill.ts` already generates — and the operator's `cru-skilled.md` / `cru-house-marker/SKILL.md` are still on disk. Missing piece is three env vars in the run invocation. |
| **CRU-6** | **(a) with a (b) shell** | The agent files exist and are fixture-creatable; what actually blocks is a Claude card whose model completes a delegated turn (gateway model never returns; the proxy card 403s our session tools) plus an operator trust decision on a real repository. The note "fixture: parent delegates both arms" describes a superseded attempt-1 symptom. |
| all four | **none is (c)** | Every feature under test still exists with the symbols the cases name. |

## Things I could not determine

- Which `blocked()` actually fired for CRU-3 and CRU-1 in the 2026-08-21 sitting — the close-out records only a blanket "fixtures/env, unchanged from history".
- Whether `/Users/i.i.gavrikov/Desktop/react-ui-kit` is currently trusted (project-trust records are hashed).
- Whether the dp JWT in `~/.nessy/dp_auth_creds.json` is still valid (I did not read its contents); the RTS fixture header claims validity to 2028-07-04.
