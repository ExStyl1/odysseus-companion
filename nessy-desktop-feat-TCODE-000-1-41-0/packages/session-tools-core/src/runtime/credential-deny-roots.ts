import { isAbsolute, join } from 'node:path';

/**
 * Paths a sandboxed command must never read.
 *
 * Necessary because no isolation profile restricts reads by default — every
 * backend grants ambient whole-filesystem read and scopes only *writes*: darwin
 * emits `(allow file-read*)` (`filesystem-isolation.ts`), linux binds
 * `--ro-bind / /`, and win32 writes `":root" = "read"`. The backend strings say
 * so literally (`host-read:write-workspace+scratch`). `sandboxing.md:312` states
 * the same posture and its cost: "**Default read behavior**: read access to the
 * entire computer, except certain denied directories. Note that this default
 * still allows reading credential files such as `~/.aws/credentials` and
 * `~/.ssh/`." An explicit deny is the only protection these files have, and the
 * `networked` profile — the shipped default for the foreground shell — is the
 * case where a read and an outbound connection are available to the same
 * command.
 *
 * `sandboxing.md:271` — "There is no built-in credential deny list, so only the
 * files and variables you list are restricted." We ship one anyway, because an
 * empty default means every install that never wrote the setting is exposed.
 *
 * ## How this list was enumerated
 *
 * Not from memory. Each entry is the path the owning tool's own documentation
 * names, cross-checked against what exists by NAME on a developer machine we
 * ship to:
 *
 * - `~/.netrc` and `~/._netrc` — curl(1): "Make curl scan the .netrc file in the
 *   user's home directory for login name and password", and "On Windows two
 *   filenames in the home directory are checked: .netrc and _netrc".
 * - `~/.docker` — `docker login`: credentials are stored in
 *   `$HOME/.docker/config.json`. The whole directory rather than that one file:
 *   `contexts/` carries endpoint TLS material for the same registries.
 * - `~/.git-credentials`, `~/.config/git/credentials` — git-credential-store(1)
 *   names both, the second as `$XDG_CONFIG_HOME/git/credentials`.
 * - `~/.npmrc` — npmrc(5): `$HOME/.npmrc`, which is where `_authToken` lives.
 * - `~/.pypirc` — the packaging.python.org pypirc specification: `$HOME/.pypirc`.
 * - `~/.kube` — the kubeconfig documentation: `$HOME/.kube/config`.
 * - `~/.gnupg` — the GnuPG manual (`secring.gpg`, `private-keys-v1.d`,
 *   `trustdb.gpg`).
 * - `~/.config/gh` — `gh help environment`: "$HOME/.config/gh".
 * - `~/.config/gcloud` — the gcloud configurations page.
 * - `~/.azure` — the Azure CLI configuration page: "AZURE_CONFIG_DIR … The
 *   default value … $HOME/.azure on Linux and macOS".
 * - Browser cookie and login stores — Chromium's `user_data_dir.md` gives the
 *   per-OS user-data directory ("[Chrome] ~/Library/Application Support/Google/
 *   Chrome", "[profile dir] …/Default"), and every Chromium fork uses the same
 *   layout under its own vendor directory. A `Cookies` / `Login Data` SQLite file
 *   in there is a live session for every site the user is signed in to, which is
 *   the highest-value thing on the disk after the SSH key.
 * - `~/Library/Keychains`, and the Windows DPAPI trio under `AppData` — the OS
 *   credential stores themselves.
 *
 * ## `~/.gitconfig` stays READABLE, deliberately
 *
 * It is the one entry on the candidate list that a routine command needs on
 * every invocation: identity (`user.email`), `safe.directory`, `core.excludesfile`
 * and aliases all live there, and `git` reads it before it does anything else. A
 * sandbox that breaks `git` gets switched off, and then it protects nothing. It
 * is also not primarily a secret: the secret git keeps is in
 * `~/.git-credentials` (or the platform helper), and that file IS denied above.
 *
 * What `~/.gitconfig` can do is EXECUTE — `core.pager`, `alias.x = !cmd`,
 * `credential.helper = !cmd` — so it is denied for WRITE instead, by
 * {@link credentialDenyWriteRoots}. Residual, stated rather than hidden: an
 * operator who puts a live token in `http.extraHeader` or in an `insteadOf` URL
 * is still exposed by this decision.
 *
 * ## Shape
 *
 * A directory entry needs no globbing — darwin renders one
 * `(deny file-read* (subpath …))`, linux masks the tree, win32 writes one `deny`
 * key. Adding an entry is safe; removing or weakening one is not.
 *
 * The gateway JWT lives under `~/.nessy`, which is NOT the app's own
 * `~/.nessy-agent` config dir — `~/.nessy` is shared with nessy-cli — so the
 * `credentials.enc` deny does not cover it. The WHOLE DIRECTORY is denied, not
 * just `dp_auth_creds.json`: something outside our control (the `dp` tool or
 * nessy-cli) keeps `dp_auth_creds.json.bak` / `.bak2` copies of the same token
 * next to it — `saveCreds` writes atomically and creates neither — so denying
 * only the one filename leaves readable copies and the deny is bypassed by
 * reading a sibling. Rotated backup names are not ours to predict. The rest of
 * that tree (`dp_latest/`, `device_id`, `installation_id`, `insights/`,
 * `debug/`, `certs/`, the CLI's memories) is another product's private state
 * that a sandboxed command the agent runs has no business reading either.
 * Nessy's own gateway auth is unaffected: it resolves `dp` from PATH and
 * `execFile`s it in-process, never under this isolation.
 *
 * ## `NESSY_HOME` MOVES that directory, and this floor follows it — DA1.5
 *
 * `~/.nessy` is nessy-cli's directory and nessy-cli publishes the variable that
 * relocates it; `packages/shared/src/auth/dp/creds-store.ts` symbol
 * `getNessyDir` honours the same name, so the gateway JWT can live outside
 * `$HOME` and a floor spelled `join(homeDir, '.nessy')` would not cover it.
 * Shipping the variable without this is a switch that moves the credential out
 * of every floor.
 *
 * The relocated root is ADDED, never substituted for `~/.nessy`: this module's
 * own rule two paragraphs down is *"Adding an entry is safe; removing or
 * weakening one is not"*, and a value set mid-session must not un-deny the
 * directory the session has been writing to. Only an ABSOLUTE value counts,
 * which is the whole of `getNessyDir`'s rule — deliberately total, so that this
 * copy and the three others cannot resolve the same variable differently. This
 * module stays a leaf with no workspace imports (see the last paragraph), so
 * the rule is re-stated here rather than imported, and
 * `packages/shared/src/agent/__tests__/credential-floor-parity.test.ts` pins the
 * two against each other.
 *
 * ONE constant, read by BOTH call sites (`SessionManager`'s ProcessSupervisor and
 * `script_sandbox`). The defect this closes was a forgotten call site, so two
 * hand-written lists would reproduce it. This module deliberately stays a leaf
 * with no workspace imports: `server-core` depends on `session-tools-core`, never
 * the other way round, and the caller supplies both roots.
 */
export function credentialDenyRoots(
  homeDir: string,
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = (...parts: string[]): string => join(homeDir, ...parts);
  // The relocated nessy directory, when `NESSY_HOME` names one — see the
  // `NESSY_HOME` section above. Additive: `home('.nessy')` stays in the list.
  const relocatedNessyHome = process.env.NESSY_HOME?.trim();
  const roots = [
    join(configDir, 'credentials.enc'),
    home('.ssh'),
    home('.aws'),
    home('.nessy'),
    home('.netrc'),
    home('_netrc'),
    home('.docker'),
    home('.git-credentials'),
    home('.config', 'git', 'credentials'),
    home('.npmrc'),
    home('.pypirc'),
    home('.kube'),
    home('.gnupg'),
    home('.config', 'gh'),
    // glab's legacy and XDG-default directory, holding `token` and
    // `oauth2_refresh_token` (`gitlab-org/cli/internal/config/config_file.go`).
    // Its repo-local sibling `<git dir>/glab-cli/config.yml` is NOT here: this
    // list is absolute roots for the isolation profile, and the workspace copy
    // is covered by `deniedPaths`' `**/.git/glab-cli/**` instead.
    home('.config', 'glab-cli'),
    home('.config', 'gcloud'),
    home('.azure'),
  ];
  if (relocatedNessyHome && isAbsolute(relocatedNessyHome) && relocatedNessyHome !== home('.nessy')) {
    roots.push(relocatedNessyHome);
  }
  // Per-platform, because a browser profile's location is the one thing on this
  // list that is not a dotfile in `$HOME`. An entry naming a directory this host
  // does not have costs one unmatched rule, so the split is for readability and
  // profile size rather than correctness.
  if (platform === 'darwin') {
    const support = (...parts: string[]): string => home('Library', 'Application Support', ...parts);
    roots.push(
      home('Library', 'Keychains'),
      home('Library', 'Cookies'),
      home('Library', 'Safari'),
      home('Library', 'Containers', 'com.apple.Safari'),
      // The vendor directory, not `Google/Chrome`: Chrome Beta, Dev and Canary
      // are siblings under it with their own cookie stores.
      support('Google'),
      support('Chromium'),
      support('Microsoft Edge'),
      support('BraveSoftware'),
      support('Arc'),
      support('Vivaldi'),
      support('com.operasoftware.Opera'),
      support('Firefox'),
    );
  } else if (platform === 'win32') {
    roots.push(
      home('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      home('AppData', 'Local', 'Chromium', 'User Data'),
      home('AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
      home('AppData', 'Local', 'BraveSoftware'),
      home('AppData', 'Local', 'Vivaldi', 'User Data'),
      home('AppData', 'Roaming', 'Mozilla', 'Firefox'),
      // DPAPI: the credential blobs and the master keys that decrypt them, which
      // is also how a Chromium profile's cookie encryption key is protected.
      home('AppData', 'Roaming', 'Microsoft', 'Credentials'),
      home('AppData', 'Local', 'Microsoft', 'Credentials'),
      home('AppData', 'Roaming', 'Microsoft', 'Protect'),
    );
  } else {
    roots.push(
      home('.config', 'google-chrome'),
      home('.config', 'chromium'),
      home('.config', 'microsoft-edge'),
      home('.config', 'BraveSoftware'),
      home('.config', 'vivaldi'),
      home('.config', 'opera'),
      home('.mozilla'),
      // gnome-keyring's on-disk store, and the NSS database Chromium and
      // Firefox use for client certificates.
      home('.local', 'share', 'keyrings'),
      home('.pki'),
    );
  }
  return roots;
}

/**
 * Paths that must stay READABLE and must never be WRITABLE.
 *
 * The other half of the credential question. `~/.gitconfig` holds no secret
 * worth denying reads for (see {@link credentialDenyRoots}), but a sandboxed
 * command that can WRITE it owns the next `git` invocation: `core.pager`,
 * `alias.x = !cmd` and `credential.helper = !cmd` all run an arbitrary command,
 * and the last one also redirects the credential itself to an attacker's helper.
 * That is code execution plus credential capture from a file nobody thinks of as
 * executable.
 *
 * Only reachable when a grant overlaps it — `(deny file-write*)` is already the
 * floor and only the workspace root and the scratch dir are opened — which makes
 * this exactly the case `sandbox.filesystem.allowWrite` creates when an
 * administrator grants a home-directory subtree. Emitted after every write allow
 * on all three backends, so the deny wins inside the wider grant.
 *
 * Every read-denied root above is already unwritable: darwin emits a write deny
 * beside each read deny, linux masks the tree, and win32's `deny` outranks
 * `write` in the same key map. So this list carries only the readable ones.
 *
 * No `platform` parameter, unlike {@link credentialDenyRoots}: git reads the
 * same two locations relative to the home directory on all three.
 */
export function credentialDenyWriteRoots(homeDir: string): string[] {
  return [
    join(homeDir, '.gitconfig'),
    join(homeDir, '.config', 'git', 'config'),
  ];
}
