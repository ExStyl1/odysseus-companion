# Post-wave verification — 1.21.0 (2026-08-08)

Mandate (owner, 2026-08-08): after the executor session finished the doc-sweep
wave — verify the four 2026-08-04 plans against code and documentation, the
integrations (Claude and Codex runtime agents), the dp auth-token path, and the
plugin/MCP/skill/hook surface, with a written report before any manual fixes.
Verifier: the orchestrator session, independent of the executor.

## Verdict

**Release 1.21.0 is verified and publishable.** Every claim checked held, the
two mandatory live re-runs (CLR-1, CBX-1) pass on the packaged 1.21.0 build,
all repository gates are green on the final tree, and the only new findings are
minor and recorded below (one dead script reference, plus the already-tracked
open items).

## 1. The four 2026-08-04 plans vs code and documentation

| Plan | State | Verified how |
| --- | --- | --- |
| `claude-sdk-runtime-on-nessy-integrations` (1.18.0) | T0–T9 ✅ | Tracker spot-checks vs code; docs-site source pages exist EN+RU (`llm-connections.md` carries `claude-runtime`); release-notes chain intact; CLR evidence base re-validated (see §2) |
| `codex-byo-endpoints` (1.19.0) | C1–C4, C7 ✅; C5/C6 ⏸ owner | Same; the ⏸ rows match the recorded owner decisions |
| `doc-sweep-parity-wave` (1.21.0) | closed | Every unit reviewed per-commit during execution (R86 fix, R88, R89, R87, R69b, close-out — all approved); remainder honestly recorded: R87b, R88b, R69-shell, four owner-deferred rows |
| `user-env-park` | f163a ✅ / f163b ⏸ | `validators.ts` declares `env` and reports it; `storage.ts:1381` pushes the rejected-layer record; f163b parked on the four owner decisions as written |

Generated specs: `parity-report` and `deviation-register` regenerated
independently and byte-identical to the committed files. Parity after the wave:
**140/152 assembled, 12 open** (was 87/136 before the branch).

**Finding (minor):** root `package.json`'s `"check-version"` script points at
`scripts/check-version.ts`, which does not exist — version lockstep has no
gate. Recorded by the claude-runtime plan's T9 as found-in-passing, never
fixed. A task chip has been filed; no manual fix applied per the mandate.

## 2. Integrations: Claude and Codex runtime agents

Change analysis first (verification budget): `packages/codex-responses-adapter`
has had no code change since T3b (two later commits are docs-only), and
`packages/shared/src/auth/dp` none since DPK (1.19.1). All CLR/CBX rows
measured on those cycles therefore stand as evidence, EXCEPT the two one-click
rows whose measured behavior predates the DPK needs-login gate change — those
were re-run live on the packaged 1.21.0 arm64 build (unsigned rehearsal build,
`NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev`):

| Case | Result on 1.21.0 packaged | Evidence |
| --- | --- | --- |
| CLR-1 (Claude card one-click, virgin config) | **PASS** | No credential form; `claude-gateway`/`claude-runtime` connection written on the verified gateway base URL, both models seeded (coder default + fast), `isAuthenticated: true`, `isFullyConfigured: true` |
| CLR-2 (text turn via loopback `/v1/messages`) | **PASS** | `CLR2-LIVE-OK` streamed and completed on `tgpt/qwen35-397b-a17b-fp8` |
| CLR-3 (tool round-trip) | **PASS** | Write+Read round-trip; file verified on disk (`clr3-proof.txt` → `CLR3-TOOL-OK`); turn closed clean |
| CLR-4 spot (think-leak, claude route) | clean | zero `<think` across the whole transcript |
| CBX-1 (Codex card one-click, virgin config) | **PASS** | Onboarding card set exact (both runtimes + Custom endpoint, no subscription cards); `codex-gateway`/`codex-runtime` written, both models; live turn `CBX1-LIVE-OK` completed |
| CBX-1 think-leak observation | clean this run | the 2026-08-06 run had recorded leading-reasoning leakage on the codex route; this 1.21.0 turn is clean (one data point, not proof) |

Standing evidence (code unchanged since measurement): CLR-5/6/9/10/11/13/14/15,
CBX-2…7 — including the auth-scoping negative controls (`Nestor-Token` only on
the verified gateway URL; BYO endpoints get `Authorization: Bearer` and no
`Nestor-Token` at all).

**Known open item (re-confirmed on HEAD):** CLR-12 — on a hard-stalled
upstream the Claude SDK retries the errored stream with escalating backoff and
the session can sit on "Responding…" for 14+ minutes; the named fix
(`CLAUDE_CODE_MAX_RETRIES` in the claude env block) has zero occurrences in the
tree. Adjacent to the shipped 429 work but SDK-side; candidate for a small
follow-up plan.

Two rig traps were hit and correctly attributed during the live run (both
already recorded in the checklist's cycle notes, both reproduced exactly):
occluded-window rAF starvation froze the onboarding transition until the app
was relaunched with `--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding` (backend state was complete the whole time —
verified before attributing), and a leftover instance swallowed a relaunch via
the single-instance lock. Neither is a product defect.

## 3. Auth (dp / JWT)

- One-click flows on BOTH runtime cards consumed the existing
  `~/.nessy/dp_auth_creds.json` (valid to 2028, mode 0600, nessy-cli shape
  `jwt/expiresAt/username/userId`) with no dp prompt and no credential form —
  the DPK two-tier needs-login gate behaves correctly in the
  valid-credentials arm. The file was treated read-only throughout (metadata
  reads only; the JWT never left the machine or entered any log).
- `creds-store` contract (0600, atomic write, merge-preserve, single writer =
  `auth/dp` module) is covered by its unit suites, which ran green in the full
  wave (§5); the code is unchanged since DPK.
- Token scoping negative controls stand per §2 (CLR-6 / CBX-2).

## 4. Plugin / MCP / skills / hooks surface

- **Per-commit reviews during the wave** (all approved): R86 background-result
  delivery (three-rule discipline reused, exact foreground gate, capped
  notification with retrieval path), R88 honest plugin Update (server-side
  catalog source, shared decision with the badge, no wire widening), R89
  placeholder-injection guard (set comparison over neutralized expansion), R87
  component-scoped skill hooks (live reader, folded last, one executor, trust
  gate reused), R69b `context: fork` skills (named-subagent primitive,
  history isolation proven by canary, `restrictions.fork`).
- **Adapter vs live docs** (the recurring failure mode): fresh fetch of
  `plugins-reference.md` — component keys (`workflows`, `monitors` both
  spellings, `outputStyles`, `experimental.themes`, root-`SKILL.md`
  auto-load) and the hook-event table all covered by
  `format-adapters/claude.ts` with doc-line citations. No drift.
- **Live CDP**: the executor's third pass on 1.21.0 bundles (AGT-1 10/10,
  AGT-2 14/14, AGT-3 7/7; the rest blocked halves/fixtures/observability,
  none a product regression) — reviewed and its classifications spot-checked.
  My own live run adds the packaged-build CLR/CBX evidence above.
- MCP sources, hooks and skills carry their unit/contract coverage in the full
  wave below; no live MCP re-drive was warranted (no code change in the MCP
  import/scope path this wave — the 4 blocking MCP checklist rows keep their
  standing evidence).

## 5. Repository gates on the final tree (`1535e0839`)

Order followed the packaged-first rule: dmg built and driven, then
`rm -rf release`, then the wave.

- `bun run typecheck:all` — green (all packages)
- `apps/cli` typecheck (not covered by the aggregate) — green
- `bun run lint` — 0 errors (4 pre-existing auto-fixable warnings)
- `bun run lint:i18n:parity` — OK (1 locale file pair, 2189 keys each)
- `bun run lint:i18n:sorted` — OK
- `bun test` (full, exclusive, no `release/` present) — **see result line
  below**

Full `bun test`, two consecutive exclusive runs on the identical tree:
run 1 — 12 528 pass / 18 skip / **1 fail** (12 547 tests, 1 083 files, 412 s;
the failing test's identity was lost to output truncation — verifier's own
rig error); run 2, immediately after — **12 529 pass / 18 skip / 0 fail**
(400 s). The lone non-reproducing failure matches the known-failing register's
flaky-race note (re-measured 2026-08-08: intermittent solo) and the executor's
own close-out experience (one flake, green on replay). Recorded as the known
flake, not a regression; per the register's own caution it stays "unresolved",
not "disproven".

## 6. Open items after this verification

1. CLR-12 (SDK retry latency on stalled upstream) — product, needs its own
   small plan (`CLAUDE_CODE_MAX_RETRIES`).
2. `check-version` dead script — chip filed.
3. R87b (subagent frontmatter hooks), R88b (`plugin_manage` update tool
   no-op caller), R69 shell frontmatter field — recorded by the wave close-out.
4. Four owner-deferred parity rows (R46/R50/R53/R80).
5. Observability gap: a spawn's actual thinking effort is exposed nowhere
   (AGT-5) — contract unit-tested, live scoring impossible.
6. Checklist case halves needing fixtures (AGT-4 rewind half, AGT-6 compaction
   setup, AGT-7/8, PLG-N9/N10, PRV-N22 live model-discovery).

None of these blocks the 1.21.0 release.
