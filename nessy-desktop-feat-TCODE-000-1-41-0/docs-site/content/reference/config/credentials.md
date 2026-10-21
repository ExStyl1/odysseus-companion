# Credentials

Nessy Desktop keeps API keys, OAuth tokens, and other secrets in an encrypted
file, separate from the non-secret [config file](/reference/config/config-file).
This page explains where that file lives, how it is protected, how credentials
are keyed, and how to inspect or remove them.

## Location

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`:

```
CONFIG_DIR/credentials.enc
```

The saved token for a remote Workspace is owned by this vault under
`remote_server_token::{workspaceId}`. Workspace config stores only the remote
URL and remote Workspace ID; tokens never appear in Workspace DTOs or reconnect
prefill data.

## Clean-cutover authentication boundary

Storage v2 never imports the old `credentials.enc` from a quarantined v1 home.
Provider and Source credentials must be entered or authorized again.

Nessy Gateway is the exception because its existing shared file is outside
`CONFIG_DIR`:

```
~/.nessy/dp_auth_creds.json
```

Storage readiness and cutover treat this nessy-cli contract as external and
read-only. During normal Gateway authentication,
`packages/shared/src/auth/dp` is the only Nessy Desktop writer. A valid cached
JWT is reused by that existing auth flow; the file is not copied into v2 or
changed during cutover.

## Encryption

Credentials are sealed with authenticated encryption:

- **Algorithm**: AES-256-GCM.
- **Key derivation**: PBKDF2 (100,000 iterations) over a stable machine
  identifier.
- **Machine identifier**: the OS-native hardware UUID — `IOPlatformUUID` on
  macOS, `MachineGuid` on Windows, `/var/lib/dbus/machine-id` on Linux — with a
  username/home-directory fallback if that is unavailable.

Because the key is bound to the machine, the file can only be decrypted on the
computer that wrote it. Copying `credentials.enc` to another machine will not
work; you re-authenticate there instead.

::: info
There is no OS keychain prompt. The encrypted-file backend provides
keychain-grade protection without an interactive unlock on every launch. The
environment-variable credential backend is disabled, so credentials are never
sourced from shell environment variables — you enter them through the app.
:::

## Credential keys

Each stored secret is addressed by a `::`-delimited key. The delimiter is `::`
rather than `/` so it never collides with slashes in URLs or paths.

**Global credentials (2 parts):**

```
{type}::global
```

**LLM connection credentials (2 parts):**

```
{type}::{connectionSlug}
```

**Workspace credentials (2 parts):**

```
workspace_oauth::{workspaceId}
```

**Source credentials (3 parts):**

```
{type}::{workspaceId}::{sourceId}
```

## Credential types

| Type                  | Description                                            | Scope          |
| --------------------- | ------------------------------------------------------ | -------------- |
| `anthropic_api_key`   | Anthropic API key (legacy global)                      | Global         |
| `claude_oauth`        | Claude OAuth token, Pro/Max subscription (legacy)      | Global         |
| `telemetry_salt`      | Per-install pseudonymization salt for opt-in telemetry | Global         |
| `llm_api_key`         | API key for an LLM connection                          | Per connection |
| `llm_oauth`           | OAuth token for an LLM connection                      | Per connection |
| `llm_iam`             | AWS IAM credentials                                    | Per connection |
| `llm_service_account` | GCP service-account JSON                               | Per connection |
| `workspace_oauth`     | Workspace MCP OAuth token                              | Per workspace  |
| `remote_server_token` | Remote Workspace server token                          | Per workspace  |
| `source_oauth`        | OAuth token for an MCP/API source                      | Per source     |
| `source_bearer`       | Bearer token for a source                              | Per source     |
| `source_apikey`       | API key for a source                                   | Per source     |
| `source_basic`        | Basic auth (base64 `user:pass`) for a source           | Per source     |

::: info
`anthropic_api_key` and `claude_oauth` remain supported global key types. New
setups store credentials per LLM connection, keyed by the connection slug. This
does not import a v1 credential file.
:::

## What lives here vs. config

Only secrets belong in `credentials.enc`. Non-secret routing metadata — model
names, base URLs, source names, workspace and connection identifiers — stays in
`config.json` and the per-workspace files, which are plain JSON. Do not paste
secrets into prompts, source definitions, or documentation unless the field is
explicitly a credential field.

## Examples

```
anthropic_api_key::global
claude_oauth::global
llm_api_key::nessy-gateway
llm_oauth::claude-max
remote_server_token::ws-abc123
source_oauth::ws-abc123::github
source_bearer::ws-abc123::internal-api
```

## Adding credentials

Credentials are captured automatically when you:

- Complete the setup flow (API key or OAuth login).
- Connect a source that requires authentication.
- Authenticate against an MCP server.

## Removing credentials

To clear everything, quit the app and delete the file:

```bash
rm "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

On the next launch you re-authenticate for each connection and source.

## Rotation

Rotate a secret from Settings. Restart any active session that may have already
handed the old value to a running subprocess, so it picks up the new one.

## Security considerations

**File permissions.** The credential file is written for your user only. On a
POSIX system you can confirm:

```bash
ls -la "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
# expect -rw-------
```

**Backups.** Back up the entire `CONFIG_DIR`, including this file. It stays
encrypted and cannot be decrypted on a different machine. External Projects,
`~/.agents`, and `~/.nessy/dp_auth_creds.json` are outside that backup.

**Machine migration.** Moving to a new computer means re-entering credentials —
the encrypted file from the old machine will not decrypt on the new one.

**Shared OS accounts.** Users who share one operating-system account share one
credential file. Use separate accounts for isolation.

## Troubleshooting

**"Credential not found".** The entry may have been removed or the file reset.
Re-enter the API key in Settings, or re-run the OAuth login when prompted.

**"Cannot decrypt credentials".** This usually means the file came from another
machine. Delete it and re-authenticate:

```bash
rm "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

**File permission errors.** Restore owner-only access:

```bash
chmod 600 "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

### Gateway sign-in troubleshooting

Since 1.38.0 a chat on a Nessy Gateway card never waits on the `dp` command-line session: the gateway token the app holds carries the turn, and a session that has ended shows one notice ("Your Developer Platform session has ended") while only the Developer Platform tools refuse. A different notice ("Nessy could not reach the Developer Platform command line") means the `dp` binary itself did not answer — check the three commands below in that case.

If the Nessy Gateway card loops on a 401 ("token is malformed") or Sign in
fails outright, the app now self-heals a broken cached token automatically —
so a loop that persists past one retry usually traces back to `dp` itself.
Check it directly:

```bash
dp version                      # must be >= 13.x
dp auth print-token | wc -l     # must print exactly 1
dp ai mcp jira                  # must stay running (Ctrl-C to exit), not error out
```

If any of those is off: update `dp`, delete `~/.nessy/dp_auth_creds.json`
(the shared file described above), then click Sign in on the gateway card. If
[`NESSY_HOME`](/reference/config/environment-variables#nessy-home) is set, that
path moves with it — delete the file in the directory that variable names.

#### Sign-in failure codes

When gateway sign-in fails, the card shows one of the messages below and the app
records the code beside it. Since 1.41.0 the banner, the onboarding step and
**Settings → AI → Reconnect** name the same failure too, where they used to say
only that sign-in failed (Reconnect said nothing at all). There is one row here for every member of
`DpAuthError` in `packages/shared/src/auth/dp/errors.ts`, which is where the
codes are defined — if you meet a code that is not in this table, the table is
the thing that is out of date.

| What the card says | Code | What it means, and what to do |
| ------------------ | ---- | ----------------------------- |
| Developer Platform CLI was not found | `DpNotFound` | `dp` was not found in any of the four places Nessy Desktop looks, in order: the path in [`NESSY_DP`](/reference/config/environment-variables#nessy-dp), the system `dp` (your `PATH`, then `/usr/local/bin/dp`), `CONFIG_DIR/dp/bin/dp`, and nessy-cli's `NESSY_HOME/dp_latest/dp`. Nessy Desktop never downloads it for you — install it, or ask corporate IT for it; [`NESSY_DP`](/reference/config/environment-variables#nessy-dp) describes the whole order, including what happens when the path you name is not runnable. |
| Developer Platform sign-in is required | `NeedsLogin` | There is no `dp` session, or the one there was has stopped working. Click **Sign in** on the card, or run `dp auth login` yourself. The chat itself keeps working — only Developer Platform tools refuse. **One exception:** if the gateway itself rejected the turn and the token re-mint that would have fixed it needed a sign-in, the turn cannot go through on the token the app holds. That message is not lost — it is held on the card, and signing in re-sends it for you. |
| Developer Platform sign-in failed | `LoginFailed` | `dp auth login` ran and did not finish: the browser step was not completed, or `dp` reported an error of its own. Retry, and watch the browser tab it opens. |
| Developer Platform command failed | `ExecFailed` | A `dp` command exited with an error that is none of the more specific cases above. Run `dp version` and `dp auth print-token` in a terminal to see what `dp` actually says. |
| Developer Platform token exchange failed | `ExchangeFailed` | `dp` produced a token, but the gateway refused to exchange it for a session token or answered with something unusable. Check your network and VPN, then retry. |
| Developer Platform sign-in timed out | `Timeout` | A `dp` step outlasted its budget — 30 seconds for `dp auth print-token`, 5 minutes for `dp auth login`. Retry; if it keeps happening, `dp` is probably stuck trying to reach its own backend. |
| Developer Platform opened a browser for sign-in and never heard back. That browser may not be visible on this machine… | `LoginBrowserTimeout` | `dp auth login` waited five minutes for a browser nobody could see — a headless box, an SSH session, a remote desktop. The card names the address the sign-in has to reach on THIS machine (`http://localhost:25565/auth`); finish the sign-in in a browser that can reach it (over SSH, forward that port), then click **Sign in** again. Not the 30-second `Timeout` above: that one is a `dp` step that never answered, this one is a browser that never came back. |
| Developer Platform sign-in was cancelled | `Cancelled` | The sign-in was cancelled — by the Cancel button, or by whatever started it going away. Click **Sign in** again. |
| Developer Platform sign-in is available only in the local desktop app | `InteractiveLoginUnavailable` | Something asked for a sign-in where nobody can answer a browser prompt: a headless run, or a second sign-in while one is already under way. In the app, let the first one finish. Headless, set [`NESSY_DP_AUTH_TOKEN`](/reference/config/environment-variables#nessy-dp-auth-token) instead of signing in. |
| Developer Platform sign-in failed. NESSY_CLI_DP_AUTH_TOKEN is set and NESSY_DP_AUTH_TOKEN is not — Nessy reads only its own variable. Set NESSY_DP_AUTH_TOKEN, or sign in interactively. | `CliEnvTokenOnly` | Sign-in failed on its own terms, and the only delegated-token variable on the machine is nessy-cli's. The two are not interchangeable — see [Not the same as nessy-cli's variable](/reference/config/environment-variables#nessy-dp-auth-token). Export [`NESSY_DP_AUTH_TOKEN`](/reference/config/environment-variables#nessy-dp-auth-token) as well, or sign in from the card. This code never appears on its own, and it replaces only the three failures your own variable would have avoided by skipping `dp` entirely — `DpNotFound`, `NeedsLogin` and `LoginFailed`. Every other failure keeps its own row above: a refused token exchange, a timeout, a cancelled sign-in or a `dp` command error is reported as itself, because setting the variable would not have avoided it. |

Two things happen before one of these codes reaches you:

- **While `dp auth login` waits for the browser**, every sign-in surface shows a
  **Copy sign-in link** button (macOS and Linux). If no browser tab appeared, open
  the link in a browser on this computer — the sign-in finishes at
  `localhost:25565` here.
- **When `dp` itself cannot answer** — `DpNotFound`, `ExecFailed` or `Timeout` on
  `dp auth print-token` — sign-in first tries the `dp` session already saved on
  this computer, read-only, and exchanges it once for the gateway token. If that
  works, you see no code; the sign-in says it used the saved session instead. Fix
  `dp` anyway: once that session expires, signing in needs it again.

#### What Nessy Desktop does to `dp_auth_creds.json`

**It never deletes it.** Clearing the file is the one step you do by hand.

**It does rewrite it**, atomically and preserving any keys it does not own, on
two paths:

- after a successful Sign in or a token re-mint, and
- whenever it adopts a still-valid token from nessy-cli's
  `~/.nessy/oauth_creds.json` — with no `dp` run and no sign-in prompt of any
  kind.

The second path is why the file can come back on its own after you clear it: a
nessy-cli login, which you would not think of as a Nessy Desktop sign-in, is
enough to seed it. And the sharing runs both ways — nessy-cli reads this same
file too, so clearing it can make that tool sign in again on its next use.
