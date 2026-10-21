# Codex binary provenance — where `codex-app-server` comes from, and whether the registry can reproduce it

**Row:** P3.224 (§G1). **Lane:** S0-2, wave 2 stage 0. **Measured:** 2026-09-03, every number below
re-run on that date against the live sources; nothing is quoted from an earlier reading.

Owner decision 2026-09-02 (§G1): *establish the provenance and record it first; the pin does not move
until the source is known.* This is that record. **No pin was moved.** The one recommendation is in §6.

> **Extended 2026-09-11 — the pin has since moved, and §1–§7 are the 2026-09-03
> reading.** Nothing below this line was edited: it is the record the owner asked
> for, at the tag it was taken against. The pin is `rust-v0.150.1` since
> 2026-09-11 (P7.2, `f042e5674`), which is §6's recommendation reaching its own
> stated condition rather than being overturned — and §4's one concrete finding
> shipped in the meantime. **Read §8 for what we ship today, and read every
> version, hash and count in §1–§7 as dated.**

---

## 1. What we actually ship

| | |
| --- | --- |
| Artefact | `codex-app-server` — upstream `variant: "codex-app-server"`, **not** the `codex` CLI/TUI |
| Version | `0.148.0` (binary self-report: `codex-app-server 0.148.0`) |
| Upstream tag | `rust-v0.148.0`, repo `openai/codex` |
| Channel | **GitHub Releases**, `https://github.com/openai/codex/releases/download/rust-v0.148.0/` |
| Vendoring script | `scripts/fetch-codex.mjs` |
| Pin file | `packages/codex-protocol/manifest.json` (`upstream.tag` + per-platform `archiveSha256`/`binarySha256`) |
| In git? | **No.** `apps/electron/.gitignore:14` ignores `resources/bin/codex/`; the binaries are fetched, the hashes are committed |
| Pinned by | `19442298b`, 2026-08-20, *"chore(deps): codex app-server rust-v0.147.0 → rust-v0.148.0"* |

Tag history of the pin: `rust-v0.142.5` (`845cf0a41`, 2026-07-05) → `rust-v0.147.0` (`d74050e40`,
2026-08-13) → `rust-v0.148.0` (`19442298b`, 2026-08-20).

The TUI is deliberately not bundled (`scripts/fetch-codex.mjs`, *"Normal mode still bundles only
`codex-app-server`, never the TUI"*). The three Windows restricted-token sandbox executables are the
one exception, taken from the full Windows package.

## 2. The chain, re-verified end to end on 2026-09-03

Every link re-measured today, not read from the manifest:

```
GitHub release rust-v0.148.0
  └─ codex-package_SHA256SUMS (release-published)   codex-app-server-package-aarch64-apple-darwin.tar.gz
       = 759350a0ee1e0e6c3a031be88636f20aae4a556ae743bcb7cf6f559d2173f8bf
  └─ archive downloaded today, sha256                759350a0…f8bf   ✓ equals the sums line
  └─ manifest.json archiveSha256                     759350a0…f8bf   ✓
  └─ tar -xzf → bin/codex-app-server, sha256         26e0c83cd8d642777384103208ad660a5f1fe95ffebc1a4f022c0a031a673b6b
  └─ manifest.json binarySha256                      26e0c83c…3b6b   ✓
  └─ shipped file on disk                            26e0c83c…3b6b   ✓
  └─ archive's own codex-package.json                {"version":"0.148.0","variant":"codex-app-server"}
  └─ binary --version                                codex-app-server 0.148.0
```

All four archives pinned in `manifest.json` match today's release sums byte for byte:

| Archive | `manifest.json` `archiveSha256` | release `SHA256SUMS` |
| --- | --- | --- |
| `codex-app-server-package-aarch64-apple-darwin.tar.gz` | `759350a0…f8bf` | identical |
| `codex-app-server-package-x86_64-apple-darwin.tar.gz` | `e7b8058e…027d` | identical |
| `codex-app-server-package-x86_64-pc-windows-msvc.tar.gz` | `6d03c545…92e0` | identical |
| `codex-package-x86_64-pc-windows-msvc.tar.gz` (Windows sandbox) | `cc09f725…61ff` | identical |

And all six installed files hash to their pins (`darwin-arm64`, `darwin-x64`, `win32-x64`
app-server, plus the three Windows sandbox executables).

**The provenance is not weak, and it is not undocumented — it was simply never evaluated as a
posture.** It carries three checks a bare registry pin does not: the release-published
`codex-package_SHA256SUMS` at fetch time, a packaging-time assertion on the final artifact
(`scripts/build/codex-integrity.ts`, which exists because signing rewrote the Mach-O and shipped a
sev-1 in 1.25.0), and a runtime refusal-to-spawn on hash mismatch
(`packages/codex-agent-server/src/manifest-verifier.ts`). The tag itself is machine-checked:
`packages/codex-agent-server/src/__tests__/runtime-info.test.ts:12` asserts `rust-v0.148.0`.

What is genuinely true and worth stating plainly: **the organisation's approved registry is not in
that path.** `scripts/fetch-codex.mjs` says so in its own header — *"Fetched direct from GitHub
Releases (NOT npm — Artifactory npm quarantine)"*.

## 3. Two corrections to the P3.224 premise

The row was written from a 2026-08-28 reading. Both of its registry claims are wrong today, and one
of them was an artefact of how the mirror works rather than a fact about its contents.

**(a) `dist-tags.latest` is `0.148.0`, not `0.147.0`, and plain `0.148.0` is present.**
Measured 2026-09-03 against `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/@openai%2fcodex`
(HTTP 200, unauthenticated, 12.58 MB, 3889 versions):

```
dist-tags: {"latest": "0.148.0", "beta": "0.1.2505172116", "native": "0.1.2505291658"}
0.148.0            published 2026-08-18T22:30:14.842Z   PRESENT
0.148.0-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}   all PRESENT
0.147.0            published 2026-08-07T01:47:21.081Z   PRESENT
```

The row's *"the plain `0.148.0` is absent entirely"* does not hold. Note the publish date —
2026-08-18, ten days **before** the measurement that called it absent. See (c) for why.

**(b) The registry could never have reproduced our binary — at any version — and the reason is not
the version.** The npm channel publishes a *different artefact*. Downloaded and inspected today:

| | npm `@openai/codex@0.148.0-darwin-arm64` | our GitHub archive |
| --- | --- | --- |
| tarball sha1 | `2d20ed3c…093d` (matches Artifactory metadata) | n/a |
| `codex-package.json` `variant` | **`codex`** | **`codex-app-server`** |
| `version` | `0.148.0` | `0.148.0` |
| entrypoint | `bin/codex` | `bin/codex-app-server` |
| contains `codex-app-server`? | **no** | yes |
| entrypoint sha256 | `b0308517…1e50` (`codex-cli 0.148.0`) | `26e0c83c…3b6b` (`codex-app-server 0.148.0`) |

Full npm payload: `bin/codex`, `bin/codex-code-mode-host`, `codex-path/rg`,
`codex-resources/zsh/bin/zsh`. **No `codex-app-server`.** Upstream's own `variant` field is the
authority here — the two are sibling builds of the same version, and only the `codex` variant is
published to npm. So *"no hash match"* is the structurally correct outcome, not a supply-chain
smell, and **pinning back to 0.147.0 would not produce a match either.**

**(c) The mirror is a lazily-refreshing proxy frozen at 2026-08-19, and a negative reading from it
is time-sensitive.** Its newest cached publish is `0.149.0-alpha.2` (2026-08-19T23:04Z) — 15 days
stale. It does **not** fetch on demand; uncached versions return **403**, not 404:

| Request | Result |
| --- | --- |
| `codex-0.147.0-darwin-arm64.tgz` (in metadata) | **200** |
| `codex-0.149.0-alpha.2-darwin-arm64.tgz` (in metadata) | **200** |
| `codex-0.150.0.tgz` / `codex-0.151.0.tgz` / `codex-0.152.1.tgz` (not in metadata) | **403** |

Two consecutive metadata fetches minutes apart returned different newest entries
(`0.149.0-alpha.1` then `0.149.0-alpha.2`), so the cache also varies between nodes. **This is the
most reusable finding in this document:** an "absent from Artifactory" reading is a reading with a
timestamp and a cache behind it. The 2026-08-28 measurement was almost certainly such a lag
artefact, and it is the reason P3.224 existed at all.

## 4. A concrete finding: the Windows sandbox trio *is* reproducible from Artifactory

The one part of the codex chain that npm **can** supply, measured today. All three files in
`@openai/codex@0.148.0-win32-x64` are byte-identical to our pins:

| File | our `manifest.json` pin | npm `0.148.0-win32-x64` |
| --- | --- | --- |
| `codex.exe` | `2ad2cf8a732da68b8f141634f92db1a03016c5faf533a7225fbc0fb740130410` | identical |
| `codex-command-runner.exe` | `d90ed117dfa8b9f155fae4306e848e956dd8c2836b43864b6488a12decf648dc` | identical |
| `codex-windows-sandbox-setup.exe` | `cce5d63a096eefb8ff4624e65f00f11553735a01d7f2789a8869e72bcf74dba3` | identical |

This matters because `.gitlab-ci.yml:412` names that trio as one of five `github.com` downloads
blocking the Windows build, and the only one that is **mandatory regardless of every feature flag**
(*"build-win.ps1 throws without it"*). Sourcing it from `npm-all` instead would remove one blocker
from that list at no loss of integrity — the pinned hashes are unchanged, so
`fetch-codex.mjs`'s existing verify-only comparison still gates it. **Not implemented here** (this
lane does not move code); recorded as a follow-up for whoever owns the Windows CI unpark.

## 5. Blast radius, if the pin ever moves

`rust-v0.148.0` is cited **140 times across 69 tracked files** under `packages/` + `scripts/`
(96 files repo-wide including `docs/`). Almost every one is a *measurement citation* — "measured
against the shipped binary at `rust-v0.148.0`" — in `approval-bridge.ts`, `runtime-manager.ts`,
`config-warning.ts`, `server-warning.ts` and their tests. A tag bump does not just swap a binary; it
**invalidates the evidence tier of every one of those claims**, which under `AGENTS.md`
§"The two runtimes need different evidence" are the *strong* cells of the codex column. The
2026-08-13 bump precedent is on record: it caught a real deserialization defect
(`ReviewDecision.denied`) and annulled prior sandbox measurements outright.

## 6. What "latest available" means for codex — and the recommendation

The owner's 2026-09-02 directive is *upgrade all three runtimes to the latest version available in
Artifactory*. For codex that phrase needs one measured substitution before it can be executed, and
then it answers itself:

- **Artifactory's `@openai/codex` `latest` is `0.148.0`** — the exact version we already ship.
  Everything newer is 403. So on the directive's own terms, **codex is already at
  Artifactory-latest**, and the directive is satisfied by the version number today.
- **Upstream stable is `rust-v0.152.1`** (GitHub `releases/latest`, checked 2026-09-03; upstream is
  already publishing `0.153.0-alpha.*`). That is **four minors** ahead — not the patch-sized move
  Pi (`0.84.0`→`0.84.2`) and Claude (`0.3.223`→`0.3.233`) are. `rust-v0.152.1` does publish the
  app-server archives, for six targets now including `aarch64-pc-windows-msvc`.

The three options as the row framed them, re-costed against the evidence above:

| Option | Cost / verdict |
| --- | --- |
| **(a)** stay on `0.148.0`, record the non-registry provenance as an accepted posture | **Zero cost.** The chain is verified, triple-checked and machine-tested; the version equals Artifactory-latest. |
| **(b)** pin back to `0.147.0` for reproducibility | **Strictly dominated — buys nothing.** npm carries no `codex-app-server` at 0.147.0 either (§3b), so reproducibility is unchanged, while every codex measurement (§5) must be re-run at an *older* tag. |
| **(c)** wait for non-alpha `0.148.x` to land in Artifactory | **Premise false, twice.** Plain `0.148.0` landed on 2026-08-18 and is `latest`; and it would still be the `codex` variant, never the app-server. This is waiting for something that cannot arrive. |

**Recommendation: (a) — keep `rust-v0.148.0`, and record the GitHub-Releases provenance as the
accepted, verified posture.** The reason is not inertia: the artefact we ship is published only on
GitHub Releases, so no registry pin at any version can reproduce it, and the chain we do have is
stronger than a registry pin — a release-published sums file, a committed double hash, a
packaging-time assertion on the signed artifact, and a runtime refusal-to-spawn. (b) and (c) both
rest on the corrected premises in §3 and buy no reproducibility at all.

Two things travel with that recommendation, neither of them a pin move:

1. **Do not fold codex into stage 0.3's symmetric "bump all three".** For Pi and Claude,
   "Artifactory-latest" is a patch bump with a small re-measurement. For codex it is a no-op —
   and the *upstream*-latest alternative is a four-minor jump that invalidates 140 evidence
   citations (§5). If the owner wants codex on `rust-v0.152.1`, that is its own row with its own
   re-measurement wave, and it should be a decision made on the evidence cost, not on the symmetry
   of the phrase "all three".
2. **Source the Windows sandbox trio from `npm-all`** (§4) — measured byte-identical, removes the
   one mandatory `github.com` download from the Windows build path, changes no pinned hash.

## 7. Reproducing this

```sh
# the chain (needs github.com egress)
curl -fsSL -O https://github.com/openai/codex/releases/download/rust-v0.148.0/codex-package_SHA256SUMS
curl -fsSL -O https://github.com/openai/codex/releases/download/rust-v0.148.0/codex-app-server-package-aarch64-apple-darwin.tar.gz
shasum -a 256 codex-app-server-package-aarch64-apple-darwin.tar.gz   # vs the sums file and manifest.json
tar -xzf codex-app-server-package-aarch64-apple-darwin.tar.gz && shasum -a 256 bin/codex-app-server

# the registry (unauthenticated 200)
curl -s 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/@openai%2fcodex' | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d["dist-tags"])'
# the 403-vs-200 control that proves the mirror does not fetch on demand
for v in 0.147.0-darwin-arm64 0.152.1; do curl -sSI -o /dev/null -w "$v %{http_code}\n" \
  "https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/@openai/codex/-/codex-$v.tgz"; done
```

Downloads go to a scratch directory, never into the repo — the tarballs are 90–130 MB and
`apps/electron/resources/bin/codex/` is gitignored on purpose.

---

## 8. 2026-09-11 — the pin moved to `rust-v0.150.1`, and what that does to each section above

Added by W11-v2 (P6.1071) from the lift's own report; every value here is quoted from
the lane that measured it (P7.2, W11-codex) or re-derived below with the command that
produced it. §1–§7 are untouched.

**The decision.** §6 recommended **(a)** — stay on `rust-v0.148.0` — and the owner took
it on 2026-09-05 with a sequencing attached (P3.283): finish the plan on the shipped
tag, then lift all three runtimes together at close-out, so the difference is visible
against a plan that is otherwise still. The owner ruling of 2026-09-10 (point 4) is that
close-out, and P7.2 executed it. So §6 was not reversed; its condition was met, and its
reasoning — that no registry pin at any version can reproduce this artefact — survives
the move intact.

### 8.1 What we ship now

| | |
| --- | --- |
| Artefact | `codex-app-server` — unchanged; upstream still publishes it only as a release asset |
| Version | `0.150.1` (binary self-report: `codex-app-server 0.150.1`) |
| Upstream tag | `rust-v0.150.1`, repo `openai/codex` |
| Channel | **GitHub Releases** for the app-server; **the configured npm registry** for the Windows sandbox trio — see §8.2 |
| darwin-arm64 archive sha256 | `5679ec494e2dfc52638678e51b05daf6a870be2c1d84a2e558df0403318ed69d`, verified against the release `codex-package_SHA256SUMS` by `scripts/fetch-codex.mjs`'s own run |
| darwin-arm64 binary sha256 | `99ed12a1db8f479388178bd308e3411ed9c6b38b0ce2fafaee5a9390f5f9a1e9` |
| Generator | the same release's `codex-cli 0.150.1`, its archive matching the same sums file |
| Pinned by | `f042e5674`, 2026-09-11, *"feat(codex): the pin moves to rust-v0.150.1, and the idempotent skip learns to see a tag bump"* |

Tag history of the pin, extended: `rust-v0.142.5` (`845cf0a41`) → `rust-v0.147.0`
(`d74050e40`) → `rust-v0.148.0` (`19442298b`, 2026-08-20) → `rust-v0.150.1`
(`f042e5674`, 2026-09-11).

**What comes out of the archive is one file of several, and that is new.** At
`rust-v0.150.1` the app-server package is `codex-package.json` + `bin/codex-app-server`
+ `bin/codex-code-mode-host` + `codex-path/rg` + `codex-resources/zsh/bin/zsh`, and
`fetchTarget` installs only the app-server. Boot is proven fine without the siblings (a
byte-identical `initialize` from a bare directory, W10-f); code-mode, the bundled `rg`
file-search path and the zsh shell-snapshot path are NOT proven, and that is a surface
question rather than a provenance claim.

**The question was put to the owner and refused for 1.36.0 — QX5 = B, 2026-09-11.** It
was asked as *bundle all three extra binaries in 1.36.0* against *do not bundle them
now, record it, and let the next plan decide by surface*; the answer is the second, on
the reasoning that three binaries would ship for surfaces this fork does not show.
`scripts/fetch-codex.mjs` symbol `fetchTarget` therefore keeps installing only
`bin/codex-app-server`, and no script or manifest changed with this record. **What is
unavailable in consequence, stated rather than implied:** code-mode (`--code-mode-host`
has no host to spawn), the bundled `rg` file-search path, and the zsh shell-snapshot
path — each unavailable, not broken, because the app-server itself boots without them
(W10-f's byte-identical `initialize` from a bare directory is the whole evidence that
this is a surface cost and not a boot risk). **Who decides next, and by what:** row
`I2.25` of Phase 2 in `docs/superpowers/plans/2026-09-10-integrations-and-authorization.md`
— one surface at a time, with the live arm that question needs, rather than a single
bundle-or-not verdict taken here.

### 8.2 §4's finding was implemented, and it is now the DEFAULT source

§4 recorded the Windows sandbox trio as reproducible from the registry and left it as a
follow-up. It landed as P3.282 (`ad6e3f430`, `756c1b99a`): `scripts/fetch-codex.mjs`
`--windows-sandbox` now defaults to `--windows-sandbox-source=npm`, reading
`@openai/codex@<version>-win32-x64` from whatever `npm_config_registry` names — which in
this pipeline is the Artifactory mirror — and `=github` is kept for a bad day. The CI
blocker list §4 pointed at was corrected from five to four in the same work.

**§4's hash table is a 0.148 reading and does NOT carry.** All three files hash
differently at the two tags; at `rust-v0.150.1` the pins are, from `packages/codex-protocol/manifest.json`:

| File | `binarySha256` at `rust-v0.150.1` |
| --- | --- |
| `codex.exe` | `cbd657ddfe151d1a6ebad660beffdbd3265dc5aff4b3a6095124d3e2f0156f2f` |
| `codex-command-runner.exe` | `bc69bd270c70fdffbc2a648ffe3ab5e1c2bcf8295f31fac4bd8547d020ffc8a9` |
| `codex-windows-sandbox-setup.exe` | `9a81b03a86c3a597d3df1e9d14e8a9bb25d926d0266d7ddd5cefb0307a9f9b1b` |

The manifest now also carries the registry's own identifiers for that tarball
(`windowsSandbox.win32-x64.npm`: `version` `0.150.1-win32-x64`, `tarballSha256`
`ce5aed36…c79`, `integrity` `sha512-1P1tscFn…`), and the lift's drive verified the
anchors independently: the registry's published `dist.integrity` and `dist.shasum`
before the archive is opened, the pinned `npm.tarballSha256` on the downloaded bytes,
and the three per-file `binarySha256` after extraction. The per-file gate is the one the
runtime verifier ultimately trusts and it did not move; what moved is the archive-level
anchor, from the release sums file to the registry's own digest. (The lift's report calls
that set *"all five anchors"* while naming six checks; the names are the durable half —
count them from the script, not from the sentence.)

**A hand-edit that is deliberate, and the reason is worth keeping.** Both
`--windows-sandbox` paths COMPARE against the manifest's pins and throw on a mismatch
rather than rewriting them, so the `windowsSandbox` block is hand-edited to re-measured
values BEFORE the script runs, and the script is then the verifier. §1's "regenerated by
this script, never hand-edited" therefore holds for `binaries` and not for
`windowsSandbox` — the same correction U4 recorded in 2026-08.

### 8.3 §3's readings, re-taken at the new tag

- **(a) `dist-tags.latest` reads `0.150.1`** (2026-09-11, the lift's re-read). §3(a)'s
  own lesson is the durable half: this is the perishable line of that paragraph and it
  has now turned over twice. Re-read it; never quote it.
- **(b) still the structurally correct outcome, re-measured rather than carried.** The
  whole `@openai/codex@0.150.1-win32-x64` package is eight members and not one of them is
  a `codex-app-server` — it carries `bin/codex.exe`, `bin/codex-code-mode-host.exe`,
  `codex-path/rg.exe` and the two sandbox executables. So no registry pin at any version
  reproduces our binary, at this tag as at the last.
- **(c) unchanged in kind**, and now with a second confirmation from the other
  direction: the `0.150.1-win32-x64` trio the lift needed WAS on the mirror, cached, and
  both registry anchors verified — which is what an "absent from Artifactory" reading
  looks like when it is a cache reading rather than a fact.

### 8.4 §5's blast radius, and why its number should not be compared with the new one

§5's *"140 times across 69 tracked files"* was a 2026-09-03 reading over `packages/` +
`scripts/`. The lift measured its own corpus (`packages apps scripts`, minus `generated/`
and `codex-protocol/schema/`) and reported **340 lines / 141 files at its base → 231
lines / 118 files at exit, none of them naming a codex source path**; P7.2's row records
**342 lines over 146 files** at `6fb422f48`. Three numbers, three instruments — they are
not a series, and subtracting them measures the definitions rather than the work.

This lane's own reading, 2026-09-11 at `30e9148e2`, with the command that produced it:

```sh
git grep -a 'rust-v0\.148\.0' -- packages apps scripts | wc -l   # 206 lines, 106 files
git grep -a 'rust-v0\.148\.0' | wc -l                            # 571 lines, 146 files repo-wide
```

Excluding `generated/` and `codex-protocol/schema/` from the first: 196 lines over 102
files. **365 of the repo-wide lines are in `docs/`**, and they are dated readings by
design — a finished plan, a run narrative and a spec record what was true when they were
written, which is why this section is an extension and not a rewrite. The rule §5 states
is the one that matters and it is unchanged: a tag bump invalidates the evidence tier of
every measurement citation, and under AGENTS.md those are the *strong* cells of the codex
column.

### 8.5 Two provenance findings the lift produced

**The idempotent skip could not see a tag bump.** `fetch-codex.mjs --all`, run straight
after the tag moved, printed "already present + verified" for all three targets,
refetched nothing, and left the previous release's binaries on disk under the new tag's
manifest — because the skip compared the on-disk binary against the manifest's own
recorded sha and nothing else. That is precisely the state a supply-chain pin exists to
prevent: a pin that says one thing and ships another. Fixed in the same commit
(`f042e5674`) — the skip now also requires the recorded `archiveSha256` to equal the
release sum for the pinned tag, which the path has already loaded — with both controls
run: stale record refetched all three in 28.08 s, current record skips again.

**The machine check §2 leans on is RED at HEAD.** §2 closes by saying the tag is
machine-checked, and cites the `getCodexRuntimeInfo` assertion in
`packages/codex-agent-server/src/__tests__/runtime-info.test.ts` by line. That citation
is still accurate — the assertion is there, and it still spells the 0.148-era tag, which
is exactly why it now fails: measured 2026-09-11 by this lane, that one path runs 2 tests
across 1 file, 1 pass / 1 fail, reading `rust-v0.150.1` where it expects the old tag
(0.55 s at load 8.8). It is not in the known-failing register. The guard did its job —
the pin moved and the test that spells the pin went red — and the lift did not update it;
so the honest reading of §2 today is that the machine check is *in place and failing*,
not that the tag is machine-confirmed.
