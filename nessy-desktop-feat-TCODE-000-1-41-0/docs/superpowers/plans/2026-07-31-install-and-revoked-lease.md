# A revoked lease bricks every send, and the marketplace catalog we cannot install from

Three defects found by driving the shipped 1.16.0 app on 2026-07-31. **F1 is a
release-blocking regression**: after installing a plugin, every chat message in
that workspace fails until the app restarts. F2/F3 are why
`nessy-default-extension` — the plugin carrying the base MCP set — cannot be
installed at all.

## Tracker

| # | task | status | commit | note |
|---|---|---|---|---|
| F1 | A revoked snapshot never takes down a send | ✅ | 1a125e90 + c0c5e0de | blocker. **Cause CORRECTED**: `assertActive` never fired. `materializer.resolveCredential` reports "credential not ready" by throwing the SAME `revoked` code, and C3 deliberately keeps an `authType` plugin server ENABLED while its slot is empty — so Figma's un-authorized OAuth server threw on `runtime-pool-servers.ts:380` on every materialization. Not a moved generation and not a race, which is exactly why it never healed. Three fixes: (1) `resolvePluginSlotCredential` degrades an empty/rotated ENDPOINT-AUTH slot to `undefined` so the C3 `endpointAuthPending` branch below it is reachable — `assertActive` runs on both sides, a non-endpointAuth credential still fails hard; (2) the registry re-resolves a fresh snapshot once and then degrades, with `degraded` read by `runSync` so a browse pool is never synced empty; (3) `preflightDpAuth` and `getWorkspacePendingAuth` stop propagating/silently emptying — the summary RE-RESOLVES (its own snapshot, `isLeaseActive`-checked so entries and requirements share a generation) because an empty summary renders no notice. LIVE before 2026-07-31T12:46Z (send → user message persisted, no reply, `Error in sendMessage: capability-snapshot-revoked`; `Pending-auth summary failed`); live after OWED — main-process fix needs `electron:build:main` + relaunch. **Follow-up landed after the lifecycle audit:** (4) `CapabilityMaterializationFailure` gains `credential-not-ready`, so `resolveCredential` throws `revoked` ONLY from `assertActive` and the security verdict stops sharing a string with "not signed in yet"; the endpoint-auth softening now catches that exact code instead of relying on a second `assertActive`. **CORRECTION — the "clears only on restart" claim is withdrawn.** It was never measured, and under the measured mechanism a restart CANNOT clear it: the failure is an absent credential-store row, which survives a restart. Positive control on ONE unrestarted process instead: 15:38 local, Figma uninstalled → send answered "OK"; 15:46, Figma reinstalled and active, same process → send produced no reply and the `capability-snapshot-revoked` stack. That is a stronger control than a restart test, and it identifies the plugin, not the process lifetime, as the variable. A packaged-build restart run is NOT owed by this row; it would test a claim that no longer stands. **Fixture sweep:** all 20 hand-built materializer `resolveCredential` fixtures in the test tree were classified (9 further hits are the HOST seam, where `{ready:false}` IS production's contract) and all 20 made faithful; measured by flipping them together — 17 files, 8641 tests — exactly 0 additional reds, i.e. every one was inert. The 4 reds that did appear were the code split's own (materializer assertions, the `pi-harness-baseline` source pin, and the two probes) |
| F2 | An entry with no `install` still yields a source | ✅ | 8bbb1f73 | 106 of 118 catalog rows. Rule derived from the 12 published commands and asserted against all 12 verbatim: `@ai-office/nessy-extension-` + gitlab GROUP + (the `/-/tree/<ref>/` subdirectory segments, leading dots stripped) for an in-repository listing, or + the listing NAME at a repository root. The repository name is never part of it (`gtech-sre/gtech-sre-context/-/tree/.../nessy-analyst-agent` → `…-gtech-sre-nessy-extensions-nessy-analyst-agent`), and at a root the name beats the repo — `b2b-ai-market/idea-to-prod-extension` → `…-b2b-ai-market-init-deploy` settles that alone. Segments lowercase, `_`→`-`: a no-op on all 12, and how `…/spark_sql_client_helper` is actually published. Measured against the real Artifactory: **114 of 116 distinct derivations resolve**; the 2 that do not (`b2b-ai-market/angular-extension`, `ai-center-qa/qa-skills/…/quality-gate-profiler`) have no published artifact under any variant tried, so the registry refuses them cleanly. Honesty: new `sourceConfidence: 'coordinates-derived'` (weaker than `command-derived`), `derivedCoordinates: true` carried onto the install source and the installed record, and an INFO `marketplace.install.derived_source` naming the exact package + version + registry. The registry is never omitted — `source-resolver.ts` records that dropping it falls back to registry.npmjs.org. Derivation is the LAST resort and only when the listing published nothing at all: a row that stated an unusable command is still refused, now with a diagnostic naming what was missing rather than the generic sentence |
| F3 | A version resolves like nessy-cli does | ✅ | 1582c9a9 | 1.0.9 vs 1.0.9-source.*. `selectNpmVersionName` replaces the exact key lookup with an ordered chain recording the matched rule: `exact` → `widened-within-base` (the highest published `<requested>-…` build whose major.minor.patch still equals the request, ordered by `semver.rcompare`, unparseable candidates refused) → `dist-tag-latest`, reachable ONLY when nothing was pinned. The candidate test is a prefix of the REQUEST, not "any prerelease sharing the base", and that is load-bearing both ways: it admits a stamp on a prerelease base (`1.0.3-beta.0` → `1.0.3-beta.0-source.…`, the only publish for 3 live rows) while still refusing `1.0.3-beta.1` for a requested `1.0.3-beta.0`. `rcompare` is what makes `-source.10.x` beat `-source.9.x`; a string sort installs the older build. Narrow documented exception to `dependencies.ts:123`'s `includePrerelease: false`, scoped to an exact pinned version matching its own base — never a range, never across bases. INFO `plugin.install.npm_version_resolved` names requested + resolved + rule, only when they differ. Fixture is the verbatim Artifactory version set of 2026-07-31. **F3 is load-bearing for F2** — measured end-to-end over all 118 live rows against the real registry: **12 installable before F2+F3** (106 refused at `unsupported_source`); **56 after F2 alone** — 62 rows moved from an early clean refusal to a late `npm_version_missing` after a metadata fetch, exactly as the lifecycle audit warned; **116 after F2+F3** (`exact` 44, `widened-within-base` 60, `dist-tag-latest` 12 = precisely the 12 rows carrying no `version`). The 2 remaining were never published to Artifactory and are refused by the registry itself |

---

## F1 — `capability-snapshot-revoked` reaches the user, forever

**Measured live.** After installing the Figma plugin, every send fails. The
stack from the running app (`electron:dev`, 2026-07-31 12:23):

```
CapabilityMaterializationError: capability-snapshot-revoked
  at resolveCredential
  at materializeSnapshotMcpServers
  at materializeRuntimePoolServers
  at WorkspaceMcpPoolRegistry.materializeRuntime
  at SessionManager.preflightDpAuth
  at SessionManager.sendMessage
```

Two facts make this a blocker rather than a transient:

1. **It does not clear.** The same error repeats across minutes and across
   sends. It is not a one-shot race that the next turn heals.
2. **A preflight kills the turn.** `preflightDpAuth` exists to *observe* whether
   dp is ready. Its `lease.materializeRuntime(runtime)` call is unguarded, so a
   materialization failure propagates out of `sendMessage` and the user sees a
   raw error instead of an answer. A preflight that cannot observe must degrade,
   not abort — the surrounding code already has an `unavailable` outcome for
   exactly this shape.

**Two fixes, and both are wanted — do not stop at the first:**

- **The seam that throws**: when materialization fails because the lease is
  revoked (`CapabilityMaterializationError` with the revoked reason —
  `materializer.ts:assertActive`), the registry must re-resolve a FRESH snapshot
  and retry once, then fail soft. A revoked lease means the capability
  generation moved (a plugin was installed, enabled, or disabled) — the correct
  response is to look again, which is what every other consumer of a moved
  generation does.
- **The caller that propagates**: `preflightDpAuth` returns
  `{ready: true, sessionState: 'unavailable'}` on a materialization failure
  instead of throwing. Establish first whether any OTHER unguarded
  `materializeRuntime` caller sits on a user-visible path and treat it the same;
  say in the report which callers you audited.

**Do not "fix" this by widening the lease's lifetime or by weakening
`assertActive`.** The assertion is a correctness floor — a stale snapshot must
never be used to resolve a credential. The bug is that nobody re-resolves.

**The second consequence — the sign-in affordance disappears.** The same
revoked lease also takes down the workspace pending-auth summary
(`Pending-auth summary failed for <workspaceId>: capability-snapshot-revoked`,
twelve occurrences across 12:20:55Z–12:43:26Z). That summary feeds the
session-start notice, and for an `authType: oauth` server the notice is the ONLY
sign-in entry point we ship. The plugin that reproduces it — Figma
(`figma@2.0.13`, openai registry) — exposes exactly one MCP capability,
`transport: http`, `url: https://mcp.figma.com/mcp`, `authType: oauth`. So
installing it both breaks every send AND removes the only way to authorize it.

Unlike `preflightDpAuth`, this path already fails soft: it warns instead of
throwing. **That is why failing soft is not the fix here** — a soft failure
yields an empty summary, and an empty summary renders no notice, which the user
cannot tell apart from "nothing needs sign-in". This path must re-resolve.

**Gate for the second consequence:** after installing a plugin carrying an OAuth
MCP server, the session-start notice still lists that server and its sign-in is
reachable — proven LIVE on CDP 9224 (Figma is installed there now). Plus a unit
at the summary seam: revoked on first attempt, live on re-resolve, returns the
pending server. **Mutation:** drop the re-resolve → the summary goes empty and
the unit goes red.

**Gate:** with a session open, installing a plugin and then sending a message
answers normally — proven LIVE through CDP on port 9224 (the app is running;
`scripts/cdp/lib/` has the helpers, and the failure reproduces today by
installing any plugin mid-session). Plus a unit at the registry seam: a revoked
lease on first attempt and a live one on re-resolve returns servers; a lease
revoked on both attempts fails soft with the requirement list empty, never
throwing. **Mutation:** drop the re-resolve → the unit goes red; drop the
preflight guard → the send-path test goes red.

---

## F2 — a marketplace entry without `install` is refused

**Measured.** `marketplace.install` for
`nestor-nessy-cli-extensions-nessy-default-extension-9bcdc6a2` refuses before
any download:

> Marketplace item "nessy-default-extension" does not expose a structured
> install source supported by Nessy Desktop.
> (`marketplace.install.unsupported_source`, `install-source.ts:224`)

The skills-market entry carries `name`, `version: 1.0.9`, 14 `capabilities.mcpServers`
and `path: https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions` — and **no
`install` field at all**. Measured across the catalog: **12 of 118 entries have
`install.command`; 106 do not.** So this is the catalog's normal shape, not one
broken row, and our resolver rejects the majority of it.

- The entries that DO carry `install.command` show the intended npm coordinates:
  `nessy extensions install @ai-office/nessy-extension-<group>-<name> --registry=https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all --auto-update`.
  The package name is derivable from the entry (`id`/`path` carry the group and
  the plugin name) — establish the exact derivation from the 12 entries that DO
  have the command, and prove it reproduces their package names before applying
  it to the 106 that do not.
- **A derived source must be honest.** Record on the install source that the
  coordinates were derived rather than published, and surface a diagnostic
  naming the package it resolved to. A silent guess that installs the wrong
  package is worse than today's clean refusal.
- If a derivation cannot be proven for an entry, keep refusing — but the
  diagnostic should say what was missing (`install` absent, path not
  derivable), not the current generic sentence.

**Gate:** the four `nessy-default-extension` catalog entries yield a source
whose package name matches the pattern the 12 published commands establish; an
entry with genuinely nothing to derive from still refuses, with a diagnostic
naming what was missing. **Mutation:** drop the derivation → the fixture goes
red.

---

## F3 — the advertised version does not exist in the registry

**Measured against the real Artifactory.**
`@ai-office/nessy-extension-nestor-nessy-default-extension` publishes:
`1.0.6`, `1.0.7`, `1.0.7-source.20260616140806.cb4784c35c5c`,
`1.0.9-source.20260716152955.45c8ba6c7514`, and two `1.0.3-beta` builds.
`dist-tags.latest` = `1.0.9-source.20260716152955.45c8ba6c7514`.

**There is no plain `1.0.9`** — but the marketplace advertises exactly that.
`selectNpmVersion` (`install-service.ts:1122`) does an exact key lookup, so the
install would fail with `plugin.install.npm_version_missing` even once F2 lands.

Note how nessy-cli avoids this: its install command **pins no version at all**
and takes `dist-tags.latest`.

- Resolve in this order and record which rule matched: exact version → the
  highest published build whose version starts with `<requested>-` (the
  `-source.<timestamp>.<sha>` CI stamp is the same release) → `dist-tags.latest`
  ONLY when it satisfies the requested base. Never silently install a different
  base version.
- Emit an info diagnostic naming requested vs resolved. The close-out already
  flagged this mismatch as an open question; this is the answer.

**Gate:** requesting `1.0.9` against the real metadata shape resolves to
`1.0.9-source.20260716152955.45c8ba6c7514` with the diagnostic naming both;
requesting `1.0.7` still resolves exactly; requesting `2.0.0` against this
metadata refuses. **Mutation:** restore exact-only matching → the fixture goes
red.

---

## F4 — category strings

**Commit:** `docs(audit): what the install and lease work leaves open`

Unwrapped, unbolded, backtick-terminated, under 400 characters. At minimum: the
derivation's confidence bound from F2, and any catalog shape it still refuses.

documented, not implemented — derived npm coordinates are a coordinate guess and
never a publisher claim: 114 of the 116 distinct derivations resolve against the
real Artifactory and the 2 that do not were never published, so a row whose
package is absent now fails at download rather than at listing; the registry, not
the derivation, stays the authority on existence `deriveNessyExtensionCoordinates`

documented, not implemented — a catalog row that states an install command this
app cannot parse is refused rather than derived from, so only rows carrying no
install field at all reach the derivation; a row that made a claim is never
second-guessed, which keeps the 12 published commands and any future unusable one
on the clean refusal `normalizeSourceFromListingCoordinates`

documented, not implemented — the installed record's provenance keeps the
marketplace's advertised version rather than the one the registry served, so a
repair or update re-widens to the newest build stamp of that base instead of
reproducing the exact artifact first installed, and no integrity digest is
persisted from the resolved dist either `reconstructInstallSource`

documented, not implemented — a version pinned with its own prerelease widens
only to a build stamp of exactly that prerelease, so a row advertising a
prerelease that was superseded rather than stamped still refuses instead of
moving to the next prerelease of the same base; crossing prereleases would be the
substitution the rule exists to prevent `selectNpmVersionName`

documented, not implemented — the send path's own materialization stays
unguarded on purpose: a pinned turn snapshot that is genuinely revoked fails the
turn rather than running it with no MCP servers at all, which would be a silent
capability loss dressed as success; only the observing preflight degrades
`BaseAgent.setSourceServers`

documented, not implemented — source credential closures handed to the pool
capture the turn's materializer and outlive its lease, so an api source's token
getter invoked after the turn ends meets a released lease and nothing re-enters
the resolver to clear it; confirmed by reading the seam, distinct from the
measured failure, and handed back for its own row `materializeRuntimeSources`

documented, not implemented — a plugin-scoped invalidation revokes every live
lease in every workspace because instance membership is not resolved there, which
is deliberate fail-closed behaviour and was left alone; it did not amplify the
measured failure, whose throw came from the credential branch and never reached
the lease check `leaseMatchesScope`

documented, not implemented — the live after for the send fix is owed because the
change is main-process only: Vite HMR cannot deliver it to the running rig, so
proving it needs a rebuilt main bundle and an owner relaunch, and the seam is
proven by unit instead `preflightDpAuth`

## Method rules

1. **Reproduce before fixing.** F1 reproduces on the running app right now; F2
   and F3 reproduce against the real catalog and registry (read-only GETs).
2. **NUL bytes** — `grep -a` always; never truncate an uncounted grep.
3. **Two git commands** — pathspec on the `commit`. One commit per task, tracker
   row in the same commit. Run every test from the repository ROOT;
   `ps aux | grep "bun test"` before each run.
4. The app on CDP **9224 is the owner's live rig and the F1 reproduction** —
   drive it, do not kill or rebuild it. `scripts/cdp/**` is read-and-run only.
5. Never write `~/.nessy/dp_auth_creds.json`; never log a token; probes that
   install go to temp config dirs, never the owner's real one.

## Constraints

No push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash; probes restored by
re-edit or `.orig`. No `Co-Authored-By`. No version bumps.
`docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md` are
planner-owned. English in code and commits.

## Report

Shas; F1 reproduced and fixed LIVE with the before/after; the callers you
audited for the same unguarded shape; the derivation rule with the evidence from
the 12 published commands; requested-vs-resolved for F3; residual category
strings; corrections to this plan; mutation probes with sides; `typecheck:all`
+ `apps/cli` exit 0 stated explicitly.
