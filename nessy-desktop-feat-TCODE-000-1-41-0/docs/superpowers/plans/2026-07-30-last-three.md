# N10, L1, L2 — the last three rows

Three rows, and two of them were found by driving the real app rather than by
reading code. That is worth saying at the top: unit tests could not have found
either, and both are things a user sees.

## 0. Method rules

1. `curl -s` the pages — `sandboxing.md` for N10, `sub-agents.md` for L1,
   `permissions.md` for L2. Quote WHOLE lines.
2. **Declared ≠ enforced.** Reproduce each defect before fixing. Prove on **Pi**.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. **A CDP dev instance is live on port 9224** (and the user owns one on 9223).
   Do not kill or rebuild for either. `scripts/cdp/` holds a working harness —
   read its README; you may RUN a case to reproduce, but do not edit the
   harness.

---

## 1. Task 1 — the filesystem layer is actually off when it says it is (N10)

**Commit:** `fix(sandbox): disabling the filesystem layer releases the deny roots`

`sandbox.filesystem.disabled` parses, resolves, and `doctor` enumerates exactly
what the user surrenders by setting it. But `resolveProcessIsolation`
(`pi-harness/isolation.ts`) still composes `selfConfigDenyWriteRoots`
**unconditionally**, so **the layer is described as off while every deny root
still binds.** `sandboxing.md:478`: the settings-file deny rules hold "unless
you disable filesystem isolation, which turns these deny rules off".

- Thread the flag from where it is resolved through the supervisor into the
  funnel, and have the funnel **skip the filesystem layer** rather than
  composing an empty one — the difference matters for the receipt.
- **Network isolation must remain.** That is the whole point of the key; prove
  it with the layer off.
- The doctor consequence line already enumerates what dies with the layer
  (`selfConfigDenyWriteRoots`, the shared-git roots, the settings `deniedWriteRoots`
  plus every `Edit(...)` deny rule, and the credential deny floor). **Make sure
  that list is still true after your change** — it was written against the
  intended behaviour, not the shipped one.
- **The credential READ floor is the question to answer deliberately.** D10 made
  it substantial. Does disabling the filesystem layer release it too? The doc
  says the settings-file deny rules go; a credential floor the product ships
  unconditionally is arguably not a settings-file rule. Decide, state it, and
  make `doctor` say the same thing the code does.

**Gate:** with the key set, a write to a previously-denied self-config path
succeeds and a network denial still holds; with it unset, nothing changes; the
doctor line matches the code's actual behaviour. **Mutation:** compose the deny
roots unconditionally again → the release test goes red.

---

## 2. Task 2 — a running fork shows its progress (L1)

**Commit:** `fix(agents): a running fork's output is readable while it runs`

Found live by the CDP wave: `read_child` returns **0 chars** for a `running`
fork on every poll for several minutes across three runs, while the pane holds
"No output yet." The same read returns the full text once terminal — 20,965
characters in one run. So the panel delivers **results, not progress**, which is
the weaker half of `sub-agents.md:1019`, "while you keep working".

- **Find out where the output stops before choosing a fix.** The child is a real
  session with its own file; establish whether the text is absent at the source,
  buffered somewhere, or present and not read. The harness author's own advice:
  read the child's session file directly.
- **The follow-up (steer) marker never landed either, and that is deliberately
  NOT filed as a second defect** — with no readable output before settle, "steer
  dropped" and "steer invisible" are indistinguishable from the renderer. Once
  progress is readable, re-check the steer: if it now works, say so; if it does
  not, that is a new finding with the evidence that was impossible before.
- Reproduce with the harness (`scripts/cdp/cases/agt-2.ts`) before and after.
  A fix asserted only by unit test would be exactly the gap the wave exists to
  close.

**Gate:** a running fork's partial output is readable while it runs, proven by
the live case, and the terminal read is unchanged. **Mutation:** revert the fix
→ the progress assertion goes red.

---

## 3. Task 3 — an answered permission card leaves the screen (L2)

**Commit:** `fix(permissions): an answered permission card is removed`

Also found live: the card renders, names its requester, and Allow genuinely
unblocks the fork to `completed` — **but the card stays on screen.** The
ambiguity was settled by state rather than by looking:
`security.pendingPermissions` is `[]` after the answer while one visible card
remains. `App.tsx handleRespondToPermission`'s own comment names this failure
("left on screen forever") as the thing it exists to prevent — so read that
comment and the code under it first; the intent is already written down.

- **A stale card is worse than cosmetic**: the next real prompt is
  indistinguishable from the stale one, so a user either answers the wrong
  thing or learns to ignore the surface.
- Establish whether this is fork-specific or applies to every prompt type. The
  wave measured it on a fork's prompt; if it is general, say so — that widens
  the row.
- **Do not fix it by hiding the card on a timer.** The removal must follow the
  state, or the two can disagree again in the other direction.

**Gate:** answering a permission removes its card, proven live; a second genuine
prompt still renders; `pendingPermissions` and the visible cards agree in both
directions. **Mutation:** drop the removal → the live case goes red.

---

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the last three rows leave open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: the credential-floor decision from Task 1.

### 4a. What the three tasks leave

Six strings, each measured against the code as committed. The first is the
credential-floor decision. The next two are surfaces the three tasks scoped out.
The last three are absences the live work found and did not fix, recorded here
rather than left unnamed.

- documented, implemented — sandboxing.md:478 turns the settings-file deny rules off with the filesystem layer and is silent on a credential floor, because sandboxing.md:271 says Claude ships none. Ours is composed in the isolation funnel, not from a settings file, and the key is settable at user scope, so the floor survives the key and doctor says so: `sandbox.filesystem.disabled`
- documented, not implemented — sandboxing.md:176 re-opens paths inside a denied region, and the funnel and both backends implement it, but nothing in production ever passes the resolved allowRead list to the supervisor: an administrator who writes the key gets no read boundary and no refusal on the two platforms that cannot bind one: `sandbox.filesystem.allowRead`
- documented, not implemented — sandboxing.md scopes the filesystem layer to every sandboxed command, and the script sandbox handler composes its own isolation from credentialDenyRoots without consulting the resolved sandbox settings, so the disable key reaches supervised processes and not that path: `script_sandbox`
- documented, not implemented — sub-agents.md:1021 has the panel open a running fork and send it follow-up messages. The child transcript is now readable while it runs, but the runtime snapshot exposes no child session id, so nothing outside the host can correlate a fork with the session that carries its text: `childSessionKey`
- documented, not implemented — permissions.md has a pending approval survive until it is answered. A renderer reload drops the in-memory prompt map and the host re-emits nothing, so a request still pending on the server renders no card and the session waits with no surface: `permission_request`
- documented, not implemented — sub-agents.md:1043 surfaces a subagent prompt in the session the user watches. The runtime snapshot filters pendingPermissions by exact session id, so a fork prompt is absent from the parent snapshot and present only on the hidden child, and no read distinguishes a stale card from a second prompt: `pendingPermissions`

## 5. Gate

Focused suites per changed file; the isolation, sessions and renderer aggregates
once on the final diff; `bun run typecheck:all` **exit 0 with zero `error TS`,
stated explicitly**; **`apps/cli`'s own typecheck separately** — `typecheck:all`
does not cover it; `bun run lint`; i18n parity + sorted if strings are added;
`git diff --check`.

**Isolation and permission decisions are named risk triggers** — run the
expanded set once on the final diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`,
including the newly-recorded `sessions.search-content.test.ts` mock leak that
fails two innocent files when it joins a run.

## 6. Constraints

- The tree is quiet — no sibling executors. You own everything the three tasks
  need. **`scripts/cdp/**` is read-and-run only**: reproduce with it, do not
  edit it. `docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md`
  are planner-owned.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`,
  and never touch `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` — live CDP fixtures.
- **Never run the sandbox against the user's real config dir** — temp dirs you
  created. Never point a probe at a real external host. The app on 9224 is
  signed into a real corporate gateway: **never log a token, JWT or header
  value**, and do not paste session content into the report.
- The runs left ~20 sessions named `CDP AGT-N <time>`; you may leave them.
- Code, comments and commits in English.

## 7. Report

Commit shas; each defect reproduced — the two live ones **through the harness**,
before and after; where the fork's output stopped and what the steer does now;
whether the stale card is fork-specific or general; the credential-floor
decision for Task 1 and whether doctor and code now say the same thing;
residuals word for word; corrections to this plan; mutation probes with which
side went red; the explicit typecheck statement including `apps/cli`.
