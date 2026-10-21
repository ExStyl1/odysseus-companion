# Headless Server

The headless server runs the complete Nessy Desktop agent runtime — sessions, workspaces, [sources](/sources/overview), [skills](/skills/overview), [statuses](/statuses/overview), [labels](/labels/overview), and [automations](/automations/overview) — without the Electron shell. Clients talk to it over the same WebSocket RPC contract the desktop app uses; the primary headless client in v1 is the [CLI](/server/cli).

::: info v1 scope
Nessy Desktop v1 runs the headless server from a repository checkout. A
self-contained distribution directory (with its own Bun runtime and resources)
can be assembled locally with `bun run scripts/build-server.ts`, but no
distribution URL is published yet, so the standalone installer
(`scripts/install-server.sh`) stays dormant and there are no container
images. The browser-facing web surfaces (`apps/webui`, `apps/viewer`) are
retained in the repo but are not a supported v1 surface. Session sharing is
disabled in v1.
:::

## Prerequisites

- [Bun](https://bun.sh) v1.x
- A checkout of the repository with dependencies installed:

```bash
bun install --frozen-lockfile
```

## Starting the Server

Generate a token and start the entry point:

```bash
export NESSY_SERVER_TOKEN=$(bun run packages/server/src/index.ts --generate-token)
echo "$NESSY_SERVER_TOKEN"   # save it — clients must present this exact value

bun run packages/server/src/index.ts
```

`bun run server:start` from the repo root runs the same entry point; `bun run server:dev` additionally builds the agent subprocess bundles and enables debug logging.

**Behind a proxy.** Bun reads `HTTP_PROXY` and `HTTPS_PROXY` only when it starts, so a server started from a checkout with one of them set — as every command on this page starts it, and as the CLI's `run` does — also sends its own requests to this machine (a local model, a loopback endpoint) through that proxy. The server prints a `[proxy]` warning at startup when this applies. Export `NO_PROXY=localhost,127.0.0.1,::1,[::1]` (plus your own entries) before starting it. A distribution assembled with `bun run scripts/build-server.ts` starts through its `bin/nessy-server` launcher, which adds those entries itself.

On startup the server prints machine-parseable connection lines — the CLI's `run` command spawns a server this way and reads them from stdout:

```
NESSY_SERVER_URL=ws://127.0.0.1:9100
NESSY_SERVER_TOKEN=<your-token>
```

### Token requirements

`NESSY_SERVER_TOKEN` is mandatory; the process exits immediately without it. Before accepting connections, the token is checked for obvious weakness:

- shorter than **16 characters** → startup is refused (`Weak server token`)
- a single repeated character (`aaaaaaaaaaaaaaaa`) → refused
- fewer than 8 distinct characters → allowed, but a low-entropy warning is logged

`--generate-token` prints a 48-character hex string (192 bits of randomness) and exits — a convenient source of compliant tokens. `openssl rand -hex 32` works just as well. Clients presenting any other value are rejected at the WebSocket handshake with `AUTH_FAILED`.

## Binding and TLS

By default the server listens on `127.0.0.1:9100`. Set `NESSY_RPC_HOST` and `NESSY_RPC_PORT` to change that; port `0` picks a free ephemeral port (which is what the CLI's self-spawned servers use).

Binding to a non-localhost address **without TLS is refused** — the token would cross the network in cleartext. Either configure TLS or, for explicitly trusted networks only, pass `--allow-insecure-bind` to override the guard (a warning is printed).

TLS is enabled by providing both a certificate and a key; the server then listens on `wss://`:

```bash
NESSY_SERVER_TOKEN=$NESSY_SERVER_TOKEN \
NESSY_RPC_HOST=0.0.0.0 \
NESSY_RPC_TLS_CERT=certs/cert.pem \
NESSY_RPC_TLS_KEY=certs/key.pem \
bun run packages/server/src/index.ts
```

Setting only one of `NESSY_RPC_TLS_CERT` / `NESSY_RPC_TLS_KEY` is a startup error. `NESSY_RPC_TLS_CA` optionally supplies a CA chain.

For local development, create a self-signed pair (valid 365 days, written to `./certs/` by default):

```bash
./scripts/generate-dev-cert.sh
```

Clients then need the CA passed via `--tls-ca` / `NESSY_TLS_CA`. For production, use certificates from a real CA or terminate TLS at a reverse proxy and keep the server on localhost.

**On a loopback bind the server accepts only its own authority in the `Host` header.** A WebSocket upgrade whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` is refused with `403 Forbidden: unexpected Host header`, and a request carrying no `Host` at all is refused too. This is the standard defence against a page in someone's browser being pointed at a server that is listening only for you: such a page must name your port to reach the server, and the browser then puts your port beside the attacker's own hostname. Every client this product ships was measured first and all of them pass.

The gate is on for a loopback bind and silent on every other bind, where a browser legitimately names a public host. The one legitimate way to meet the refusal is a reverse proxy in front of a loopback bind that forwards the public name (nginx's widely copied `proxy_set_header Host $host`): set `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` to the authority your proxy presents — comma separated, each entry written exactly as it arrives (`agent.corp.example` or `agent.corp.example:443`). The refusal itself names that variable in the server log. A deployment serving the web UI does not need to list its own address there: the server seeds the allowlist with the authority it already handed the browser.

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NESSY_SERVER_TOKEN` | yes | — | bearer token clients must present (16+ chars) |
| `NESSY_RPC_HOST` | no | `127.0.0.1` | bind address; non-local values require TLS |
| `NESSY_RPC_PORT` | no | `9100` | bind port; `0` = ephemeral |
| `NESSY_RPC_TLS_CERT` | with key | — | PEM certificate; enables `wss://` |
| `NESSY_RPC_TLS_KEY` | with cert | — | PEM private key |
| `NESSY_RPC_TLS_CA` | no | — | PEM CA chain |
| `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` | no | — | extra `Host` authorities accepted on a WebSocket upgrade, comma separated; for a reverse proxy in front of a loopback bind |
| `NESSY_DEBUG` | no | off | `true`/`1` enables debug logging |
| `NESSY_SAFE_MODE` | no | off | `1` starts sessions in safe mode: no instructions files, skills, plugins, hooks, MCP servers, commands, or agents load; managed policy still applies |
| `NESSY_CONFIG_DIR` | no | `~/.nessy-agent` | `CONFIG_DIR`; set for parallel isolated instances |
| `NESSY_HEALTH_PORT` | no | off | when > 0, serves `GET /health` on that port, on the RPC bind; behind the bearer off loopback |
| `NESSY_BUNDLED_ASSETS_ROOT` | no | repo root | root for bundled assets in packaged builds |
| `NESSY_APP_ROOT` | no | cwd | app root path override |
| `NESSY_RESOURCES_PATH` | no | `cwd/resources` | resources path override |
| `NESSY_IS_PACKAGED` | no | `false` | `true` marks a packaged production build |
| `NESSY_VERSION` | no | package version | version string reported in the handshake |
| `NESSY_WEBUI_DIR` | no | — | path to built web UI assets (dormant surface, see below) |
| `NESSY_WEBUI_PASSWORD` | no | server token | separate, shorter password for web login |
| `NESSY_WEBUI_SECURE_COOKIE` | no | auto | force the session cookie `Secure` flag on/off |
| `NESSY_WEBUI_WS_URL` | no | derived | browser-facing `ws://`/`wss://` URL returned by `/api/config` |
The variable names keep the upstream `NESSY_` prefix — that prefix is a frozen compatibility contract in this fork. The client-side variables (`NESSY_SERVER_URL`, `NESSY_SERVER_TOKEN`, `NESSY_TLS_CA`) are covered in the [CLI Reference](/reference/cli#environment-variables); the app-wide list is in [Environment Variables](/reference/config/environment-variables).

**`.env` files.** Bun loads `.env` files on its own when it starts — `.env`, `.env.local` and the `NODE_ENV` variants, in the order [Bun's documentation](https://bun.com/docs/runtime/environment-variables) gives — and it reads them from the directory the server is started in (for a systemd or launchd service, its `WorkingDirectory`), not from a parent directory. A variable already set in the launch environment keeps its value. Every launch on this page works this way, and so does the `bin/nessy-server` launcher of a distribution assembled with `bun run scripts/build-server.ts`: it runs its bundled Bun without `--no-env-file` and does not change directory, so it reads the distribution's own `.env` only when started from the distribution directory. This is left on deliberately — the launch directory is the operator's choice — but a server started inside another repository also takes that repository's `.env` (a proxy, a key, a `NESSY_*` setting). To avoid that, start the server from a directory whose `.env` files you control, or, from a checkout, turn the loading off with Bun's own switch:

```bash
bun --no-env-file run packages/server/src/index.ts
```

Arguments after `bin/nessy-server` go to the server, not to Bun, so `bin/nessy-server --no-env-file` does not turn the loading off. A file named with `--env-file` still loads under `--no-env-file`. The same goes for `bunfig.toml`: Bun reads it from the directory the server is started in, and a `preload` script it names runs inside the server before the server's own entry point. `--no-env-file` does not stop that, so a server started inside another repository also runs that repository's `bunfig.toml` preload. This too is left to Bun deliberately; to avoid it, start the server from a directory you control. When `NESSY_SERVER_TOKEN` is unset, the distribution's `install.sh` writes a generated token into the distribution's own `.env`, and the systemd unit it installs starts the server from that directory with that file as its `EnvironmentFile`.

## Data Directory and Locking

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`:

```
CONFIG_DIR/
  config.json
  credentials.enc
  recent-projects.json
  sessions/<workspace-id>/<session-id>/
  workspaces/<workspace-id>/
  plugins/
  .server.lock
```

Workspace configuration and resources live under `workspaces/<workspace-id>`;
sessions are global partitions keyed by the same immutable `workspaceId`.
`recent-projects.json` is backend-owned history for external Projects. Its
opaque handles and identity hints are revalidated before use and never grant
trust.

`CONFIG_DIR/.server.lock` enforces one server per config directory: a second
start against the same directory fails with `Another server instance is already
running (PID …)`. Locks from dead processes or a previous boot are detected and
overwritten automatically; if a crash ever leaves a genuinely stale lock,
delete the file and retry.

To run several servers side by side, give each its own `NESSY_CONFIG_DIR`.

Startup requires storage layout v2 before opening a port. Only an eligible
legacy default home is same-parent renamed to
`.nessy-agent.legacy-v1.<transactionId>`; it is never imported, read as runtime
state, or deleted automatically. A legacy custom `NESSY_CONFIG_DIR` blocks
startup untouched. Back up the entire `CONFIG_DIR`; external Projects and
`~/.agents` require separate backups.

## Managed Settings and Network Trust

The headless server enforces the same managed settings as the desktop app,
including the server-delivered layer fetched from the Nessy Gateway: the
delivery cache is refreshed periodically during active use, and a policy that
demands a fresh fetch can hold startup until a gateway sign-in succeeds. The
app-level [network proxy and TLS trust settings](/reference/config/network-proxy)
(proxy routing, bundled/system certificate stores, custom and managed CAs,
mutual TLS) apply to the headless hosts and their agent subprocesses too.

## Health Endpoint

For load balancers and probes, set `NESSY_HEALTH_PORT` to a positive port number. The server then answers `GET /health` on plain HTTP with the health payload — status 200 when healthy, 503 otherwise. The endpoint is off by default.

**It binds the same interface the RPC server binds** (`NESSY_RPC_HOST`, `127.0.0.1` by default), not every interface. On a loopback bind the probe is open, as it has always been. On any other bind it requires the server's own bearer token — the value printed as `NESSY_SERVER_TOKEN` — so a probe there is:

```bash
curl -H "Authorization: Bearer $NESSY_SERVER_TOKEN" http://<rpc-host>:<health-port>/health
```

Without it that request answers `401`. Any path other than `/health` answers `404` on every bind, as before. The startup log line names the interface it really bound and says which of the two it is.

## Web UI (dormant)

The server can embed a browser UI on the RPC port when `NESSY_WEBUI_DIR` points at built assets:

```bash
bun run webui:build
NESSY_SERVER_TOKEN=$NESSY_SERVER_TOKEN NESSY_WEBUI_DIR=apps/webui/dist \
bun run packages/server/src/index.ts
```

`bun run server:prod` performs the subprocess builds, the web UI build, and the launch in one step. Login uses `NESSY_WEBUI_PASSWORD` (falling back to the server token) and issues a session cookie that is also accepted on the WebSocket upgrade.

::: warning
`apps/webui` is a retained-but-dormant surface in Nessy Desktop v1 — it is not validated as part of releases. Prefer the CLI for headless use.
:::

## Running at Startup

### Linux (systemd)

Environment file, e.g. `/opt/nessy-desktop/.env`:

```bash
NESSY_SERVER_TOKEN=<your-token>
NESSY_RPC_HOST=0.0.0.0
NESSY_RPC_PORT=9100
NESSY_RPC_TLS_CERT=/path/to/cert.pem
NESSY_RPC_TLS_KEY=/path/to/key.pem
```

Unit at `/etc/systemd/system/nessy-server.service`:

```ini
[Unit]
Description=Nessy Desktop headless server
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/opt/nessy-desktop
EnvironmentFile=/opt/nessy-desktop/.env
ExecStart=/home/<your-user>/.bun/bin/bun run packages/server/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nessy-server
journalctl -u nessy-server -f
```

### macOS (launchd)

Plist at `~/Library/LaunchAgents/ru.nessy.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ru.nessy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>run</string>
    <string>packages/server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/nessy-desktop</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NESSY_SERVER_TOKEN</key>
    <string>YOUR_TOKEN</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/nessy-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/nessy-server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ru.nessy.server.plist
tail -f /tmp/nessy-server.log
launchctl unload ~/Library/LaunchAgents/ru.nessy.server.plist   # stop
```

## Remote Access

Do not expose the WebSocket port to the internet directly. Reasonable patterns:

- **Reverse proxy** — keep `NESSY_RPC_HOST=127.0.0.1` and let nginx/Caddy terminate TLS and forward WebSocket upgrades:

```nginx
server {
    listen 443 ssl;
    server_name nessy.example.internal;

    ssl_certificate     /etc/ssl/nessy/fullchain.pem;
    ssl_certificate_key /etc/ssl/nessy/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

- **SSH tunnel** — zero server-side setup for ad-hoc access:

```bash
ssh -L 9100:localhost:9100 user@your-server
# then connect clients to ws://localhost:9100
```

- **Private mesh VPN** — bind `NESSY_RPC_HOST` to the mesh interface address so the port is only reachable inside the overlay network; the mesh handles encryption.

## Shutdown Behavior

On SIGINT or SIGTERM the server pushes a `server:shuttingDown` notification to connected clients, waits about two seconds so they can react, flushes all sessions to disk, closes the transport, and releases the lock file.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Server token is required` | `NESSY_SERVER_TOKEN` unset | export a token (see [Token requirements](#token-requirements)) |
| `Weak server token: Token too short …` | token under 16 characters | use `--generate-token` or `openssl rand -hex 32` |
| `Refusing to bind to a network address without TLS` | non-localhost `NESSY_RPC_HOST` and no cert/key | configure TLS, or `--allow-insecure-bind` on trusted networks |
| `TLS requires both NESSY_RPC_TLS_CERT and NESSY_RPC_TLS_KEY` | only one TLS variable set | provide both paths |
| `Another server instance is already running (PID …)` | lock held by a live server in the same config dir | stop that server, or use a separate `NESSY_CONFIG_DIR`; delete `CONFIG_DIR/.server.lock` only if genuinely stale |
| Clients fail with `AUTH_FAILED` | token mismatch | pass the exact server token to the client |
| Need more log detail | — | start with `NESSY_DEBUG=true` |

For client-side connection issues, see the [CLI Reference troubleshooting table](/reference/cli#troubleshooting).
