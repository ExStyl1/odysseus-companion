# Network Proxy

Nessy Desktop can send its outbound traffic through an HTTP or HTTPS proxy —
handy on corporate networks that mandate one, or wherever a firewall blocks
direct connections.

## Configuration

Open **Settings → App → Network** and set:

| Field                    | Description                                                           | Example                             |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------- |
| **Enable proxy**         | Turn proxy routing on or off                                          | —                                   |
| **Use bundled T-Bank CA** | Trust the bundled corporate CA for Node-based requests                | On                                  |
| **Custom CA certificate** | Absolute PEM path for another corporate CA                            | `/path/to/corporate-ca.pem`         |
| **HTTP proxy**           | Proxy URL for HTTP requests                                           | `http://proxy.corp.com:8080`        |
| **HTTPS proxy**          | Proxy URL for HTTPS requests (falls back to the HTTP proxy if unset)  | `http://proxy.corp.com:8080`        |
| **No proxy**             | Comma-separated hosts/domains to bypass                               | `localhost,127.0.0.1,.internal.com` |

Settings are stored in the [config file](/reference/config/config-file) under
the `networkProxy` key:

```json
{
  "networkProxy": {
    "enabled": true,
    "httpProxy": "http://proxy.corp.com:8080",
    "httpsProxy": "http://proxy.corp.com:8080",
    "noProxy": "localhost,127.0.0.1,.internal.com",
    "tlsCaPath": "/path/to/corporate-ca.pem",
    "useBundledCa": false,
    "certStore": "bundled,system"
  }
}
```

`useBundledCa` defaults to `true` when omitted. `tlsCaPath` is optional and
takes precedence over the bundled CA. When a managed policy delivers its own
extra CA, that one outranks the user `tlsCaPath`.

`certStore` selects the base certificate sources: `bundled` (the Mozilla CA
set shipped with the runtime) and/or `system` (the OS certificate store), as a
comma-separated list. Unset means both — so a corporate root installed in the
OS store is trusted with zero configuration.

For proxies that require a client certificate (mutual TLS), three more keys
apply:

| Key | Purpose |
| --- | --- |
| `clientCertPath` | Path to the client certificate PEM; requires `clientKeyPath` |
| `clientKeyPath` | Path to the client private key PEM; requires `clientCertPath` |
| `clientKeyPassphrase` | Optional passphrase for an encrypted key — a secret, never logged |

These values are read only from the user-level config file — never from a
project, workspace, or plugin — so a checked-out repository cannot redirect
the app's TLS or proxy path.

A client certificate can also come from two other places, read under the names
`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` and
`CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`. A managed settings `env` block that names
one takes precedence over the certificate set here. When neither names one, the
app uses those variables from its own environment (on macOS, your login shell's
exports included), in the desktop app and on the headless server alike. The CA
settings apply whichever certificate is presented.

Changes apply immediately — no restart needed. The same proxy and TLS trust
settings also reach the auto-updater and the agent subprocesses, so updates
and agent traffic follow the corporate network path too.

## How it works

When the proxy is enabled, traffic is routed at three levels:

1. **Node.js main process** — `fetch()` calls (OAuth flows, MCP connections,
   API requests) go through an [undici](https://github.com/nodejs/undici)
   `ProxyAgent` installed as the global dispatcher, using HTTPS CONNECT
   tunnelling for secure connections while honouring the No-proxy rules.
2. **Electron sessions** — requests from the browser pane, the update feed
   and OAuth browser windows lean on Chromium's own proxy handling, wired up
   through `session.setProxy()`. They use the same proxy the main process
   chooses (see below), and connect directly when none is chosen.
3. **Agent subprocesses** — the Claude, Pi and Codex backends receive
   `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (plus their lowercase forms) in
   their environment, with `localhost`, `127.0.0.1`, `::1` and `[::1]` added
   to `NO_PROXY` so their calls to the app's own local services stay direct. The
   Codex binary does not read `NODE_EXTRA_CA_CERTS`, so it gets the extra CA
   file as `CODEX_CA_CERTIFICATE` instead, unless `CODEX_CA_CERTIFICATE` or
   `SSL_CERT_FILE` is already set; the client certificate set here is not passed
   to it.

TLS CA settings apply to Node.js `fetch()` whether proxy routing is on or off.

**Proxies from managed settings and from the environment.** The main process
and the Electron sessions choose their proxy in one order. A proxy set by a
managed settings `env` block comes first, then the in-app setting above, then
the environment: the first of `https_proxy`, `HTTPS_PROXY`, `http_proxy` and
`HTTP_PROXY` that is set, with `NO_PROXY` (or `no_proxy`). On macOS the
environment includes your login shell's exports. With none of these, requests
go direct. This covers the model requests of Codex and Claude Code sessions on
the gateway and custom-endpoint cards too, because there the app's local
adapter makes those requests itself, on the session's behalf. A
`NODE_EXTRA_CA_CERTS` from a managed `env` block, or on macOS from your login
shell, is trusted as well. The headless server resolves its own requests in the
same order.

## Proxy authentication

For proxies that require credentials, embed them in the URL:

```
http://username:password@proxy.corp.com:8080
```

::: warning
Those credentials sit unencrypted inside `config.json`. Where policy demands
encrypted storage, set the proxy at the OS level rather than in the app.
:::

## No-proxy rules

The **No proxy** field is a comma- or whitespace-separated list of bypass
patterns:

| Pattern            | Matches                                |
| ------------------ | -------------------------------------- |
| `*`                | All hosts (effectively disables proxy) |
| `example.com`      | Exact hostname                         |
| `.example.com`     | All subdomains of example.com          |
| `example.com:8080` | Specific host and port                 |
| `192.168.1.1`      | Exact IP address                       |
| `[::1]`            | IPv6 address                           |
| `[::1]:8080`       | IPv6 address with port                 |

::: info
Loopback addresses — `localhost`, `127.0.0.1` and `::1` — always bypass the
proxy, whatever No proxy says: a proxy handed `127.0.0.1` would reach its own
machine, not yours. Other local services, such as a host on your LAN, still
need an entry in No proxy.
:::

## TLS-intercepting proxies (corporate firewalls)

A lot of corporate proxies do TLS inspection: they re-sign HTTPS traffic under
an in-house Certificate Authority (CA). The symptom of a missing trust anchor
is `fetch failed`. Because the default `certStore` includes the OS store, a
corporate root that IT has installed system-wide is usually trusted already;
the settings below cover CAs that are not in the system store.

### Symptoms

- Signing in via OAuth throws **"fetch failed"**, or no browser window ever
  appears.
- MCP connections fail on the corporate network but work elsewhere.
- Browser-pane requests work (Chromium uses the system certificate store) while
  agent-initiated requests fail.

### Solution

Nessy Desktop ships a bundled T-Bank CA and enables it for Node-based requests
by default. This covers API key connection tests, OAuth token exchange, model
list refresh, and other requests that use Node `fetch()`, even when proxy
routing is disabled.

If your organization uses a different corporate CA, set **Settings → App →
Network → Custom CA certificate** to an absolute PEM path. The custom CA path
takes precedence over the bundled CA. You can also turn off **Use bundled
T-Bank CA** if your environment should not trust it.

As a process-start fallback, you can launch the app with `NODE_EXTRA_CA_CERTS`
set before Nessy Desktop starts:

**macOS — one-time launch from a terminal:**

```bash
NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem open -a "Nessy Desktop"
```

**macOS — permanent (Dock/Spotlight launches too):**

The app reads your login shell's environment at startup, so an
`export NODE_EXTRA_CA_CERTS=…` in `~/.zprofile` or `~/.zshrc` reaches it
however it was launched, and since 1.41.0 it covers the app's own requests as
well as its agents'. To set the variable for every app launched from the Dock
or Spotlight instead, use `launchctl`:

```bash
launchctl setenv NODE_EXTRA_CA_CERTS /path/to/corporate-ca.pem
```

Then relaunch. Verify and remove with:

```bash
launchctl getenv NODE_EXTRA_CA_CERTS
launchctl unsetenv NODE_EXTRA_CA_CERTS
```

From macOS 10.10 on, a value set with `launchctl setenv` survives reboots for
GUI sessions. On managed fleets, IT can push the same variable through an MDM
LaunchAgent plist.

**Windows — one-time launch from PowerShell:**

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\to\corporate-ca.pem"
& "$env:LOCALAPPDATA\Programs\nessy-desktop\Nessy Desktop.exe"
```

**Windows — permanent:** set a User (or Machine) environment variable named
`NODE_EXTRA_CA_CERTS` through System Properties, or:

```powershell
[System.Environment]::SetEnvironmentVariable(
  "NODE_EXTRA_CA_CERTS",
  "C:\path\to\corporate-ca.pem",
  "User"
)
```

Log out and in again, or reboot, before Explorer-launched apps will see it.

**Linux — one-time launch:**

```bash
NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem nessy-desktop
```

**Linux — permanent:** add the variable to `~/.profile` and to
`~/.config/environment.d/proxy-ca.conf` (read by systemd user sessions), then
log out and back in.

### Obtaining the CA certificate

Ask IT for the corporate proxy CA. To extract it yourself:

```bash
openssl s_client -connect api.anthropic.com:443 -proxy proxy.corp.com:8080 -showcerts </dev/null 2>/dev/null | openssl x509 -outform PEM > corporate-ca.pem
```

The certificate must be PEM (starts with `-----BEGIN CERTIFICATE-----`).
Convert a `.cer`/`.der` if needed:

```bash
openssl x509 -inform DER -in corporate-ca.cer -out corporate-ca.pem
```

Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` as a workaround. It disables TLS
verification. If you use it briefly to diagnose a local issue, unset it before
normal use.

## Troubleshooting

**"Fetch failed" on OAuth sign-in.** Almost always a TLS-intercepting proxy —
see the section above.

**Browsing works but OAuth does not.** Chromium (the browser pane) reads the
system certificate store, whereas OAuth discovery and token exchange run over
Node's `fetch()`. Keep the bundled T-Bank CA enabled or set **Custom CA
certificate** to the CA that signs your corporate traffic.

**MCP servers won't connect.** Check that the server's host hasn't been listed
under No proxy, unless bypassing it is what you intended. Local (stdio) MCP
servers are plain subprocesses, so proxy settings never touch them.

**Proxy authentication fails.** Verify credentials with `curl`, and URL-encode
special characters in the password (for example `p%40ss` for `p@ss`). NTLM
proxies are not supported directly; a local NTLM-to-Basic bridge can help.

**Confirm the proxy is active.** Check the macOS main log for the applied
settings:

```
~/Library/Logs/Nessy Desktop/main.log
```
