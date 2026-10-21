# Measure sitting 6a — the packaged 1.40.0, lane SIT-6a

**Build under test:** `release/mac-arm64/Nessy Desktop.app`, **1.40.0**, built by the controller from
`61cfc4659`. Never rebuilt, never removed. The repository tree carried four code lanes' uncommitted
`packages/**` work throughout; none of it is in the artefact, which is why every reading here is taken off
the packaged app and never off the source.

**Rig:** ports 9262–9265, each proven free with `lsof` before its launch; `NESSY_CONFIG_DIR` and
`--user-data-dir` under this lane's scratchpad, created for the run and never under `~`. The owner's profile
was never launched, `dp auth login`/`logout` were never run, and no token was read, printed or committed.
Every launch used the `env -u` launcher `scripts/cdp/README.md` prescribes; the case process got the same
treatment. The derivation command in `lib/app-env.ts`'s docblock was re-run once for this sitting and
answered **thirteen** names with readers (`ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19,
`CLAUDE_CODE_DISABLE_CRON` 12, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_CODE_SUBAGENT_MODEL` 10,
`DISABLE_AUTOUPDATER` 5, `CLAUDE_CODE_EXECPATH` 4, `CLAUDECODE` 2, `CLAUDE_CODE_OAUTH_SCOPES` 2, and four at
1). Every case run below reports `app-env: {"pids":4,"present":{},"controlSeen":true}` — the app itself
carries none of them, with the control seen on the same read.

**Building a THREE-CARD profile from a fresh config dir, which `RS-05` needs and no recipe recorded.** The
onboarding offers all four one-click cards — *"Nessy · Pi agent"*, *"Nessy · Cloud agent"*, *"Nessy · Codex
agent"*, *"Nessy · Claude Code agent"* — and accepts exactly ONE before advancing to `Get Started`. The
other two are added through the AI settings page's own **`+ Add Connection`** picker, which is the same
product path; pressing it a second time in one visit does nothing, and it opens again after navigating away
and back (`nessy-agent-navigate` → `action/new-session` → `settings/ai`). That sequence produced
`pi-api-key:pi_compat`, `codex-gateway:codex-runtime`, `claude-gateway:claude-runtime` in about two minutes,
with no key typed and no credential file read — each card signs in through the app's own dp module.

**Rig precondition:** `RS-32` **PASS** on every profile that drove a case (52 213 ms on `d175b`, PASS on
`d175c` and `d175d`) — a fresh profile lists no connection at all, and RS-32's onboarding press is the only
product path to one.

---

## 1. Two instrument rows first, before any drive

### D1.364 — `scripts/cdp/README.md`

The paragraph reading *"Installing a PLUGIN stays outside it — that goes through the app's own marketplace
flow, run by the operator"* was false by measurement (SIT-5e) and had kept five rows blocked for a
precondition no operator was needed for. Replaced with what `RS-82` and `RS-84` actually do — resolve by
name through `marketplace.list`, install through `marketplace.install`, add the official registry with one
`marketplace.addRegistry` call, uninstall through `plugin.manage` in the case's own `finally`, all in a
config dir created for the run — plus the four things those two cases paid for: `plugin.manage` takes the
`pluginKey` and not the listing id; `installedPlugins: []` and the catalog `generation` hash are the
controls; `addRegistry` resolves before the catalog is queryable; and a named plugin may simply be absent
from a reachable catalogue. What stays the operator's is restated and unchanged: the owner's live profile
and the dp credentials file.

The `Preconditions per case` table gained `RS-78`…`RS-84`, each with what it actually needs.

### D1.356 — the ten `approvePermissionsWhile` sites, and there are TWELVE

D1.347 put the approver's blindness on stderr; ten call sites went on banking `stop()`'s zero as *"nothing
asked"* while the note beside them said the count could not see. `lib/ask-user.ts` gains
`approverClaimBlockReason` (the verdict) and `requireApproverSaw` (the call site's half, the
`requireArtifactCarries` shape). Three clauses, and the third is deliberately narrower:

| clause | blocks when | why |
| --- | --- | --- |
| `counted === 0` | the loop never read the count successfully | its zero is the absence of a READING; `counted` is the instrument's own positive control |
| `blind > 0` | a card's Allow was VISIBLE on a poll that read zero | the measured class, and it blocks even when other cards WERE approved — the wedge is the card nobody counted |
| `readFailed + sessionUnseen > 0` **and** `approved === 0` | part of the window is unreadable and there is no positive reading | narrowed on purpose: a guard that discards a run over one transient throw is a guard the next operator routes around |

**The row says ten sites and the files hold twelve** — `rs-12` has two (control and subject) and `rs-17`
three. The count in the row was taken over FILES. Each conversion carries a sentence naming what its own
zero would have been read as; `rs-53`'s ROUTED/NOT-ROUTED verdict *is* the approval count, `rs-12`'s two
arms read a refusal as an absent marker file, and `rs-17`'s control B is an absence arm where a blind
approver and the intended finding are the same reading.

Every `requireApproverSaw` sits OUTSIDE the `finally` that stops the loop: `blocked()` throws, and a throw
from a `finally` running with an error in flight replaces the real failure with a sentence about the
approver.

### D1.356's last paragraph — RS-05's two owed clauses were the instrument, and the control said so

Both clauses failed on the **Pi control** as well as on claude and codex, which is the discrimination that
says the harness is the subject. Both causes are read off the shipped renderer:

* **`Esc Esc` opened the menu on none of the three.** The chord is a COMPONENT BEHAVIOUR of the composer —
  `input/double-escape.ts` says so at length and states the product consequence that it is not
  user-rebindable — so its only listener is `FreeFormInput`'s own `onKeyDown`, and that handler opens with
  `if (hasOpenOverlay()) return`. The arm pressed the two keys straight after `closeMenu()`, which closes by
  Escape or by clicking Cancel — both of which leave focus off the composer. `armDoubleEscape` now focuses
  the composer through the app's own route and records the three preconditions (dialogs on screen, whether
  the focus took, `document.activeElement` at the moment of the press).
* **The clear arm was VACUOUS, not merely unanswered.** `composerAfter.trim() === ''` is true of a composer
  that was empty all along, and an empty composer in this renderer reads back as a bare `"\n"` — which is
  exactly the `"\n"` SIT-5e recorded on all three runtimes. The composer is now read BEFORE the chord and
  that reading is its own check.
* **The restore-files button "vanished between the read and the press" on all three.** `readMenu` resolves a
  label through `selectorText`, which falls back to `textContent` when `innerText` is blank — the README's
  own trap 2 — while the press matched on `innerText` alone. So `offersCodeRestore` could see a button the
  press could not, and a null was reported as the button having vanished, a sentence nobody had measured.
  One predicate now, shared, and a miss NAMES the action labels that were on screen.

### The re-drive, which is the control the row asked for

`RS-05` re-driven on the packaged 1.40.0 on a profile carrying all three one-click cards
(`pi-api-key`, `codex-gateway`, `claude-gateway`), **19 of 20**, 250 639 ms — against SIT-5e's 15 of 19 on
the same case before the repair.

**Both `Esc Esc` clauses now ANSWER, on all three runtimes.** The menu opens on an empty composer on pi, on
claude and on codex, each with its rig recorded beside it (`dialogsBefore: 0`, `focused: "composer"`,
`activeAtPress: "COMPOSER DIV…"`); and `Esc Esc` with text CLEARS the composer instead
(`composerBefore: "A draft nobody sent"` → `composerAfter: "\n"`, `menuOpened: false`) on all three. So
SIT-5e's *"opened the menu on NONE of the three including Pi"* was the instrument, and the control it named
is what said so.

**The toast clause is still unanswered, and now has a MEASURED cause instead of a guessed one.** The press
reports what was on screen, and the two `/rewind` opens in one session disagree:

| open | action set | `offersCodeRestore` |
| --- | --- | --- |
| first (the item-set read) | `Summarize`, `Cancel`, `Rewind to here`, **`Rewind and restore files`** | true |
| second (the toast arm's own open) | `Summarize`, `Cancel`, `Rewind to here` | — the press finds nothing to press |

identically on pi, claude and codex, while `rewindTrackedChanges` answers `success: true` on every arm
(`messageIds` non-empty only on pi). So *"the button vanished between the read and the press"* is refuted:
it is not a race inside one open, it is that the SECOND open offers a different action set. That is
`P-6a-1` below.

The one FAIL is the Pi control for the toast — *"the Pi arm produced NO toast"* — which is the honest
expression of a clause that is still owed. The codex mid-turn arm measured nothing this run (the turn
settled before the openers could be driven) and says so rather than banking a reading.

---

## 2. D1.368 — a negative control must be one the product CAN pass

WI-bf measured the product directly and refuted D1.360, which came out of `RS-84`'s negative control. That
control asked `capabilities.getCatalog` for the plugin naming ZERO rows in a session whose working directory
is an unrelated git repository. The surface is a **listing**: it reports every installed plugin whatever the
session asks from and carries the scope as a FIELD on the row. The absence the control asked for is one the
product structurally cannot produce.

`carries()` is replaced by `scopeOf()`, reading what was on the wire all along —
`installedPlugins[].activation.effective`, each capability summary's `state`, and
`capabilities[].scope.projectKey`, so the case asserts WHICH project answered rather than inferring it. The
row counts are still recorded and nothing asserts on them, because `no-row` is a third state the case must
be able to name.

What makes this a README rule rather than one repair is which controls PASSED: the profile really did start
at `installedPlugins: []`, the three sessions really were in three different directories, the worktree
really was a worktree, and the main checkout really did carry the plugin. Every other control was right, and
that is what made the wrong one look meaningful. The rule now sits in §"A case needs a negative control".

### 2.1 The re-drive, and D1.70's answer is NO

`RS-84` re-driven on a fresh profile (`d368`, port 9266), **8 of 9**, the one FAIL being the row's own
answer:

| session | `activation.effective` | capability `state` | `scope.projectKey` |
| --- | --- | --- | --- |
| the main checkout (the install's own project) | **active** | `disabled` | `p_8ae115dd…` |
| a `git worktree` of the same repository | **inactive** | `disabled` | `p_3f753eb9…` |
| an UNRELATED git repository (the negative control) | **inactive** | `disabled` | `p_4acc18e1…` |

The negative control now PASSES, because it asks for `inactive` — which the product can give — instead of a
missing row, which a listing structurally cannot. And **D1.70's answer is NO**: a project-scope plugin
installed in the main checkout does not load in a worktree of the same repository, because the two resolve
to different `ProjectKey`s. The failing check is that one, phrased as *"ALSO loads"*.

All three sessions' trust gate answered `not-shown`, and §3.2 below now explains that as correct behaviour
for a bare git checkout rather than as a profile fault — which is a second reading SIT-5e recorded the other
way round.

The install and the uninstall both went through the app's own RPCs into a profile created for the run
(`installedPlugins` `[]` → the plugin → `[]`).

---

## 3. D1.75 — which settings keys wait for workspace trust

**`RS-87` (`scripts/cdp/cases/rs-87.ts`) + `fixtures/workspace-trust-settings.ts`, PASS 6/6, 1 652 ms**, on
a fresh profile (`d175d`, port 9265) whose trust gate had never been answered.

### 3.1 The row's rig names a file; the product puts that file somewhere else

The obvious reading of *"an untrusted workspace whose settings carry all four keys"* is a
`.claude/settings.json` in the directory the session works in. The first two drives wrote it there, every
surface answered empty, and the resulting silence would have been recorded as a trust gate.

The product's own `getSettingsProvenance` publishes **four families** and, per family, the exact files it
consults. Its `project` scope is rooted in the CONFIG DIR:

```
project  <config>/workspaces/<workspaceId>/.nessy-agent/permissions.json   (permissions only)
project  <config>/workspaces/<workspaceId>/.claude/settings.json
local    <config>/workspaces/<workspaceId>/.claude/settings.local.json
user     <config>/config.json
user     ~/.claude/settings.json                                          (instructionExcludes only)
managed  /Library/Application Support/Nessy/managed-policy.json, <config>/managed-delivery.json
```

So the two halves of D1.75 are rooted in two different places, and that is the reading rather than an
obstacle: the TRUST DIALOG asks about the session's **working directory**, while the settings tier it is
supposed to gate lives in the **config dir under the workspace id**.

### 3.2 The trust modal is raised for a project that DECLARES something

Measured on one fresh profile in one run, three arms, and it refutes a docblock this harness has carried
since 2026-09-11:

| arm | project | modal |
| --- | --- | --- |
| bare | one `README.md` | **none in 20 s** |
| skill | the same plus one `.agents/skills/<name>/SKILL.md` | **present after ≤2 s** — *"THIS PROJECT PROVIDES · 1 skill — cdp-probe5 · .agents/skills"* |
| after-keep-restricted | a contributing project, driven after an earlier modal was dismissed with `Keep restricted` | **present after ≤2 s** |

`lib/runtime-switch.ts` said *"the trust modal is raised for ANY directory the profile has no decision for —
a scratch dir holding one `README.md` and nothing else raises it"*. It is not, on 1.40.0. Two consequences:
a case whose rig needs the gate ANSWERED must give its scratch project something to declare (`RS-87` plants
one skill and says so where it plants it); and **`not-shown` for a bare directory is correct behaviour, not
a profile fault** — which is the third arm's point, and it bears on D1.363 (see §5).

The dialog's own buttons on 1.40.0: `Cancel`, `Keep restricted`, `Trust project`, `Close`.

### 3.3 The table the row asks for

`RS-87` reads three surfaces before the trust decision and again after it, with only the app's own
`Trust project` button between them. The modal appeared after **139 ms**; the gate answered `answered`.

| key | untrusted | trusted | surface |
| --- | --- | --- | --- |
| the FILE itself | **supplies** (`permissions`), `present-no-keys` (`instructionExcludes`, `skillOverrides`) | **identical** | `getSettingsProvenance` |
| `permissions.allow` | not visible | not visible | `getWorkspacePermissionsConfig` → **null** both sides |
| `permissions.deny` | not visible | not visible | same |
| `permissions.ask` | not visible | not visible | same |
| `permissions.additionalDirectories` | not visible | not visible | same |
| `extraKnownMarketplaces` (added) | 0 | 0 | `marketplace.listRegistries().registries` |
| `extraKnownMarketplaces` (offered) | the two built-ins only | the same two | `…​.available` |
| `env` | no family at all | no family at all | the report publishes none |

**Gated on trust: nothing. Ungated: the file itself.** On the surface the product publishes about itself,
the project-tier settings file SUPPLIES the `permissions` family while the project is untrusted, and the
trust decision moves nothing.

### 3.4 What this does NOT say, stated rather than implied

`getWorkspacePermissionsConfig` answers `null` on both sides, and the provenance report shows why: it reads
`<workspace>/.nessy-agent/permissions.json`, which is `project: missing` here. So it is **not** the reader of
`.claude/settings.json` and its null is not evidence about the four keys. What this case therefore cannot
say is whether the compiled permission LAYER honours those rules while untrusted — `permissions-config.ts`
keys its merged-config cache on `projectTrusted`, so a gate could live there and be invisible to every
surface read here. That is the residue, and the case's `unreadEither` bucket names it rather than reporting
a gate.

Two smaller nulls with their reasons: `env` has no family in the provenance report, so there is no host
surface publishing the resolved block at all; and `extraKnownMarketplaces` in a project-tier settings file
reaches neither the added registries nor the offered ones, trusted or not, which is a reading about that key
rather than about trust.

---

## 4. Rows this sitting did NOT reach, with the reason

| row | why |
| --- | --- |
| D1.66 | not reached in the window. |
| D1.73 | not reached in the window. |
| D1.67 | not reached in the window — but §3.2 changes its premise: the prompt-side arm's trust obstacle was a project with nothing to declare, not a poisoned profile. |
| D1.82 | not reached — its cost is wall-clock (two full expiry idles plus a permission prompt idled beside them). |
| D1.55 | not reached. The knob is `NESSY_MCP_AUTO_BACKGROUND_MS`; what is missing is an MCP server with a tool that sleeps past it. |
| D1.58 | not reached. Needs the loopback capture its own rig names; the claude per-session diagnostic scores 0 for every thinking-budget needle. |
| D1.72 | not reached. Nothing in the reachable catalogue writes its own config into the codex home. |
| D1.68 | not reached. `codex-security` exists in neither reachable catalogue. |

---

## 5. Proposed rows — product findings with evidence and a control, never fixes

**P-6a-1 — the rewind menu offers `Rewind and restore files` on its FIRST open and not on its second, in
the same session.** `size S to diagnose`. **Evidence:** `RS-05` on the packaged 1.40.0, all three runtimes
in one run: the first `/rewind` open's action set is
`["", "Summarize", "Cancel", "Rewind to here", "Rewind and restore files"]` with `offersCodeRestore: true`;
the second open, in the same session with no turn between them, is
`["", "Summarize", "Cancel", "Rewind to here"]` — the press looks for the button and reports the four
labels it found instead. **Control:** the server's own `rewindTrackedChanges` answers `success: true` on
every arm throughout, so the rewind path is live; and `messageIds` is non-empty on pi and empty on claude
and codex, which is the discrimination saying the two opens differ for a reason other than "there is
nothing to restore". `ChatDisplay` gates the button on that answer and **FAILS OPEN until it lands**
(`rewind-menu.tsx` `rewindOffersCodeRestore` returns true for `undefined`), which is the nearest cause —
and it means a user who opens the menu and presses quickly presses a button the product would not have
offered a moment later. **Why it matters:** it is the whole of why F2's toast clause has been owed for two
sittings, and it is a live button in a window the product cannot honour. **Zone:** the renderer's
rewind menu; not this lane's.

---

## 6. Premises this sitting corrected

1. **`scripts/cdp/lib/runtime-switch.ts`** — *"the trust modal is raised for ANY directory"*: refuted, §3.2.
   Corrected in place with the three arms and the date.
2. **SIT-5e's *"once the modal has been CANCELLED the gate answers `not-shown` for every later project in
   that profile"*** (→ D1.363's second half, and a premise in D1.75 and D1.67). Every project in that run was
   a scratch directory or a bare git checkout with nothing to declare, and §3.2's third arm shows a
   contributing project raises the modal again after a dismissal. The simpler explanation covers the same
   readings. **Whoever closes D1.363 should re-take that half rather than inherit it.**
3. **D1.356's "ten call sites"** — the named files hold twelve; the count was taken over files.
