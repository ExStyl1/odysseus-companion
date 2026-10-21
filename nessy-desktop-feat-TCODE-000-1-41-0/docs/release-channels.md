# Release and publish channels

What actually ships today, what is parked and why, and the three things that are
wrong because of the park. Read from `.gitlab-ci.yml` and the publish scripts at
`2bda53978` on 2026-09-13; every count here is a reading with a date.

## What is live

`release-macos` and `publish-macos-dev` are the ONLY live release and publish
jobs. `release-win`, `release-linux`, `publish-win-dev` and `publish-linux-dev`
are all commented out in `.gitlab-ci.yml` under a dated park comment that names
its blockers and carries an unpark recipe.

So the `dev/win/*` and `dev/linux/*` prefixes of the dev bucket are empty
because nothing writes them — **absence, not listing-denial.** That distinction
matters because the obvious probe cannot make it: a `403` on an S3 listing
cannot tell "there is nothing here" from "you may not look". Reading the publish
job answers the question the probe was reaching for, and answers it more
strongly.

## The bounded half of that claim

"No job has ever written those prefixes" is an inference, and the repo can only
take it so far. The four job definitions were LIVE in `.gitlab-ci.yml` for about
eleven days — added by `72c2571af` (2026-06-25) and parked shortly after — and
in that window:

- `release-win` could not have succeeded. It ran PowerShell under the Linux
  image and no Windows runner tag has ever existed in this project.
- `release-linux` was `when: manual` with `allow_failure: true`, on version tags
  **and on the default branch**, on the Linux fleet — so someone could have
  started an AppImage build by hand, and `publish-linux-dev` needed it with
  artifacts.

Nothing in this repository records whether that happened. Only a listing of the
bucket settles it, and that is the owner's to run — it is the one question the
403 probe would have answered had it been aimed at the right thing.

## The three residues

### 1. An installer pointing at a prefix nothing writes

`scripts/install-app.ps1` ships a Windows one-liner whose base is
`https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win` (overridable with
`NESSY_DESKTOP_INSTALL_BASE`). No CI job has ever written that prefix, so the
one-liner cannot succeed. There is no Linux installer at all, and
`scripts/install-app.sh` refuses a non-Darwin host outright.

### 2. The park comment's own arithmetic, and a third unpark option it misses

The blocker list ends **"Four blockers remain"** while the unpark sentence three
lines below still asks infra for remote proxies for **"those five assets"**. The
fifth — the Windows restricted-token sandbox trio — was measured to have an
artifactory source on 2026-09-03 and is struck through in the list itself; the
four that remain are the bun zip, the electron zip, the NSIS toolset and
winCodeSign. One of those two sentences was stale, and it was the second — corrected by `afcd33034` on 2026-09-13 (the yml now says "those four assets"); the arithmetic story stays here because it is how the drift was found.

The unpark dichotomy is also incomplete. It offers a tagged Windows runner OR an
artifactory-mirrored Wine-capable image, and there is a third door: **nessy-cli
builds its Windows desktop installer on a `macos`-tagged runner** — the same
fleet tag our own `release-macos` already uses (`build_desktop_windows`,
`tags: [macos]`, in that project's `.gitlab-ci.yml`, including Windows code
signing). Their macOS job also curls from `raw.githubusercontent.com` directly in
its `before_script`, which is exactly the egress our blocker 2 lacks on the Linux
fleet. **That is a different GitLab project with its own egress allowance and its
own signing secret, so it is evidence and not authority** — and whether OUR
`macos` fleet has the same egress is untested. It is a cheap thing to test and
nobody has.

### 3. Unparking the Linux publish would ship an UNSIGNED update feed

`apps/electron/src/main/auto-update.ts` (604 lines) carries no signature
verification of any kind. Measured 2026-09-13 with `grep -aoi <needle> <file> |
wc -l` (occurrences, not lines): `signature` 0, `gpg` 0, `pgp` 0, `publicKey` 0,
`sha512` 0, `checksum` 0, and the single `verify` hit is inside a documentation
citation in a comment — against a positive control of 19 `autoUpdater`
occurrences in the same file, so the instrument can see. `openpgp` scores ZERO
files across `package.json`, `apps/`, `packages/` and `scripts/` (control:
`electron-updater` is present in `apps/electron/package.json`). And
`scripts/publish-dev.sh` uploads the artifact and its feed manifest under ONE
prefix.

That is the same-bucket argument: a SHA-512 in a manifest published beside the
artifact it describes is an integrity check, not an authenticity one. nessy-cli
reached the same conclusion and shipped GPG detached signatures for both the
AppImage and the manifest, verified in the updater against an embedded public
key with a pinned fingerprint, refusing to go ready without them
(`docs/fork-patches/desktop-linux-update-signing.md` in that repo).

**This is a separate row and a product posture — does an unsigned Linux feed
ship? — and it is not release-channel bookkeeping.** It is recorded here so that
unparking `publish-linux-dev` cannot happen without meeting it.

## What a publish would need, and why it cannot be rehearsed today

Nothing is missing on the tooling side. `scripts/prepare-release-assets.mjs`,
`scripts/verify-update-feed.mjs` (whose `SUPPORTED_PLATFORMS` is
`['mac', 'win', 'linux']`) and `scripts/publish-dev.sh` (`--platform=mac|win|linux`)
already accept all three platforms, each with its own metadata-filename set. What
is missing is an artefact: with both release jobs parked there is nothing to
normalise, verify or upload, so the win/linux publish rehearsal cannot be run
until a release job can produce a build.

Launching publish jobs stays user-owned.
