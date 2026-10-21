# Environment Variables

Most people never need environment variables — day-to-day configuration lives
in Settings and the [config file](/reference/config/config-file). Environment
variables mainly matter for [CLI](/reference/cli) automation, local
development, proxy setup, and release/installer tooling.

::: info
Many internal variables are named `NESSY_*`. These are grandfathered from the
upstream codebase and remain supported unchanged for compatibility across the
server, Electron shell, and CLI runtime contracts.
:::

::: warning Opened from the Dock, Finder or Spotlight (macOS)
The app reads your login shell's environment at startup, but the Bedrock and AWS
provider variables, such as `ANTHROPIC_BEDROCK_BASE_URL` and `AWS_REGION`, do not
reach its agents when they are exported only in your login shell: the app resets
them at startup to the values it was launched with, which a Dock launch does not
carry. Start the app from a terminal that exports them, or set them for every
app with `launchctl setenv`, then relaunch.
:::

## CLI model selection

The [CLI](/reference/cli) `run` command reads these when the matching flag is
not passed:

| Variable       | Flag          | Purpose                                             |
| -------------- | ------------- | --------------------------------------------------- |
| `LLM_PROVIDER` | `--provider`  | Provider name (defaults to `anthropic`)             |
| `LLM_MODEL`    | `--model`     | Model id                                            |
| `LLM_API_KEY`  | `--api-key`   | API key (or a provider-specific key such as `OPENAI_API_KEY`) |
| `LLM_BASE_URL` | `--base-url`  | Custom endpoint base URL                            |

## Configuration directory

### NESSY_CONFIG_DIR

Define `CONFIG_DIR`. When set, its value is used; otherwise `CONFIG_DIR` is
`~/.nessy-agent`. It contains global config and credentials, Workspace resources,
global session partitions, backend recent-Project history, plugin state, and
logs:

```
CONFIG_DIR/
  config.json
  credentials.enc
  recent-projects.json
  sessions/<workspace-id>/<session-id>/
  workspaces/<workspace-id>/
  plugins/
```

```bash
export NESSY_CONFIG_DIR="/custom/path/to/config"
```

Multi-instance development runs set this automatically to a suffixed directory
such as `~/.nessy-agent-1`.

Only the canonical default home is eligible for automatic legacy quarantine. An
eligible old `~/.nessy-agent` is renamed beside the new home to
`~/.nessy-agent.legacy-v1.<transactionId>` and is never imported, read, or
deleted automatically. A legacy or incompatible custom `NESSY_CONFIG_DIR`
blocks startup and remains untouched.

External Projects, `~/.agents`, and the shared Gateway file
`~/.nessy/dp_auth_creds.json` do not move when `NESSY_CONFIG_DIR` changes — the
variable that moves that one is [`NESSY_HOME`](#nessy-home) below.

### NESSY_HOME

Replaces `~/.nessy`, the directory that holds the two Gateway credential files:
`dp_auth_creds.json` (the token Nessy Desktop mints and reads) and
`oauth_creds.json` (nessy-cli's, which Nessy Desktop reads as a seed).

```bash
export NESSY_HOME="/Volumes/work/nessy-home"
```

```
NESSY_HOME/
  dp_auth_creds.json
  oauth_creds.json
```

Four things to know about it:

- **The name is nessy-cli's, and so is the directory.** `~/.nessy` is shared
  with nessy-cli, and `NESSY_HOME` is the variable nessy-cli already publishes
  for it. Nessy Desktop honours the same name so that one setting moves the
  directory for both tools; a second name of our own would split a shared file
  in two.
- **Absolute values only.** A relative path, or one starting with `~`, is
  ignored and the default `~/.nessy` is used. That is deliberate and it is
  stricter than nessy-cli, which expands `~` and resolves relative paths against
  the current directory: the same path has to be re-derived identically by
  several parts of the app that cannot share code, and "absolute or the default"
  is the one rule none of them can get subtly wrong.
- **The agent's read protection follows it.** The deny floor that refuses an
  agent read of `~/.nessy` covers the relocated directory too, and it covers
  both — the old path stays denied as well, so setting this mid-session cannot
  leave either copy of a credential exposed.
- **`NESSY_CONFIG_DIR` is a different directory and does not move this one.**
  That one holds config, the encrypted credential store, sessions and logs; this
  one holds the two Gateway credential files only.

If you clear `dp_auth_creds.json` by hand while this is set, clear it in the
directory `NESSY_HOME` names — see
[Gateway sign-in troubleshooting](/reference/config/credentials#gateway-sign-in-troubleshooting).

## Developer Platform (dp)

### NESSY_DP

Names the `dp` binary Nessy Desktop runs, ahead of everywhere it would look on
its own.

```bash
export NESSY_DP="/opt/spirit/bin/dp"
```

What it changes, and what it does not:

- **The name is nessy-cli's.** nessy-cli publishes `NESSY_DP` for the same job
  and resolves a `${NESSY_DP}` placeholder in an MCP server's `command` with it.
  Nessy Desktop honours the same name so that one export points both products at
  one copy of `dp`; a second name of our own is how the two drift apart.
- **Give it an absolute path.** A relative value is resolved against whatever
  directory the app happened to start in, which is almost never what you meant.
- **Where Nessy Desktop looks, in order — and the first *runnable* one wins:**

  1. the path in `NESSY_DP`;
  2. the system `dp`: your `PATH`, then `/usr/local/bin/dp`;
  3. `CONFIG_DIR/dp/bin/dp`, under the directory
     [`NESSY_CONFIG_DIR`](#nessy-config-dir) names. **Nothing puts a binary there
     today** — Nessy Desktop has no downloader and never installs `dp` for you.
     The place is reserved so the order will not have to change if it ever gets
     one;
  4. `NESSY_HOME/dp_latest/dp`, nessy-cli's own managed copy, under the directory
     [`NESSY_HOME`](#nessy-home) names. Nessy Desktop READS it and never writes,
     updates or deletes it — that tree belongs to nessy-cli.

  If none of the four is runnable, sign-in fails with
  [`DpNotFound`](/reference/config/credentials#sign-in-failure-codes).

- **A value that is not runnable falls through; it is not an error.** If
  `NESSY_DP` names a file that is missing or has no execute bit, Nessy Desktop
  moves on to the next place in the list instead of refusing to sign in. Nothing
  reports that this happened, so a typo here looks exactly like never having set
  the variable: if sign-in works but not with the `dp` you meant, check that the
  path exists and is executable.
- **An out-of-date `dp` is stepped over, not refused.** Once Nessy Desktop has
  seen that a copy is below the minimum version it supports (13.0.0), it prefers
  any other runnable place in the list — and still uses the old copy when that is
  the only one there is. The version floor warns; it never blocks sign-in.
- **It does not move `dp`'s state, on any of the four.**
  [`DP_WORKDIR`](#dp-workdir) wins if you set it. Otherwise every place in the
  list shares your own `~/.dp`, so signing in once in a terminal signs you in here
  too — that is deliberate, and it is why a managed copy of `dp` would not get a
  private state directory of its own. When `~/.dp` does not exist yet, Nessy
  Desktop passes no state directory at all and `dp` uses its own default, so the
  first sign-in the app starts creates `~/.dp` and your terminal and the
  built-in `dp ai mcp` servers share it. (Before 1.41.0 the app created
  `CONFIG_DIR/dp/state` in that case; a sign-in kept there is not read any more,
  so such a setup signs in once more, into `~/.dp`.) It never writes inside the
  [`NESSY_HOME`](#nessy-home) tree.

### DP_WORKDIR

Not a Nessy variable — this is the system `dp` CLI's own variable for where it
keeps its mutable state (access/refresh tokens, cache) instead of the default
`~/.dp`. Nessy Desktop reads the same variable, trimmed, to find that state
root, so setting it changes two things:

- The agent's sandboxed shell is granted write access to that directory, so a
  `dp` command run inside a session can refresh its own hourly access token
  instead of reporting "not authorized" while your own (unsandboxed) terminal
  says you're signed in.
- The [built-in `dp ai mcp` servers](/sources/mcp-servers/overview#built-in-mcp-servers)
  are started with the same value, so they read tokens from the same state
  root the rest of `dp` uses.

```bash
export DP_WORKDIR="/custom/dp/state"
```

Leave it unset to use dp's own default (`~/.dp`). Nessy never creates this
directory itself — the write grant and the built-in servers' env only take
effect once the directory already exists (dp created it, or you signed in
before).

### NESSY_DP_AUTH_TOKEN

The headless, CI and `nessy-server` sign-in path for the Nessy Gateway. When it
is set, `dp` is skipped entirely: no binary is looked for, no browser is opened,
and nothing is written to `~/.nessy/dp_auth_creds.json`.

```bash
export NESSY_DP_AUTH_TOKEN="<delegated Spirit-IAM token>"
```

The value is the token **on its own** — no `Bearer ` prefix, no quotes around a
quoted value. Nessy adds the `Bearer ` itself when it presents the token.

**It wins over everything else.** It is the first step of gateway
authentication, ahead of the cached credentials file and ahead of adopting a
token from nessy-cli, and a forced re-mint leaves it alone. No setting in the
app can override it — to go back to interactive sign-in, unset the variable.

**It is not saved.** The gateway token obtained from it lives for the run only;
the credentials file is neither written nor read on this path.

**A bad value fails loudly and does not fall back.** A headless caller must see
the error rather than silently wait for a sign-in nobody can complete, so an
invalid or expired token surfaces as the
[`ExchangeFailed` sign-in failure](/reference/config/credentials#sign-in-failure-codes)
("Developer Platform token exchange failed").

::: warning Not the same as nessy-cli's variable
nessy-cli has `NESSY_CLI_DP_AUTH_TOKEN`, and both take a delegated Spirit-IAM
token with no prefix — so a value is the right *kind* of value for either. What
differs is what happens to it. nessy-cli decodes the value locally, checks its
expiry, and then uses that value itself as the credential. Nessy Desktop sends
it to the gateway's token endpoint and uses the token that comes back.

So the value is checked by the gateway here and on your own machine there: an
expired or malformed token reads as a token-exchange failure in Nessy Desktop,
and as a named `NESSY_CLI_DP_AUTH_TOKEN is invalid` / `is expired` error in
nessy-cli. Set both variables if you run both products headless.

**Setting only nessy-cli's variable now says so.** If gateway sign-in fails on a
machine where `NESSY_CLI_DP_AUTH_TOKEN` is set and this one is not, the card
reports [`CliEnvTokenOnly`](/reference/config/credentials#sign-in-failure-codes)
in place of the three failures this variable would have avoided by skipping `dp`
entirely — `dp` not found, sign-in required, and sign-in failed. Every other
failure keeps its own code, because setting the variable would not have avoided
it: a refused token exchange still reads as a token-exchange failure. Setting
it alone changes nothing else: it is never read as a credential here.
:::

## Behaviour flags

### NESSY_SAFE_MODE

Set to `1` to start in safe mode: instructions files, skills, plugins, hooks,
MCP servers, custom commands, and agents do not load, for troubleshooting a
broken configuration. Managed policy still applies — safe mode drops
third-party code, not the organization's rules. Equivalent to the CLI's
`--safe-mode` flag; directly spawned child processes inherit the variable.

```bash
export NESSY_SAFE_MODE=1
```

### NESSY_SUBAGENT_MODEL

The default model for subagents and workflow agents that are not assigned one
another way, on every runtime. A model passed for one invocation, or a `model` in
the subagent's definition (including `inherit`), still wins over it. To put this
model on every subagent instead, also set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`
(a fork still runs on the main conversation's model). Set to `inherit` to use
normal model resolution instead.

```bash
export NESSY_SUBAGENT_MODEL="tgpt/qwen36-35b-a3b-fp8"
```

### NESSY_ENABLE_TELEMETRY

Set to `1` to opt into OpenTelemetry usage metrics. An OTLP endpoint must also
be configured through the standard `OTEL_EXPORTER_OTLP_ENDPOINT` variable;
without the opt-in, nothing is exported. Telemetry is pseudonymous — a
per-install salt from the credential store keys the reported identity.

### Telemetry opt-out

Three standard names turn telemetry off, and they beat the opt-in above — on
every runtime, Pi, Claude and Codex alike, because the exporters are host-side
and not per-runtime. Nothing is exported and no per-install salt is minted.

| Variable | Rule |
| --- | --- |
| `DO_NOT_TRACK` | The cross-industry convention. Read as a boolean, so `1`/`true` opts out and `0` leaves telemetry on |
| `DISABLE_TELEMETRY` | Read only for whether it is set at all: any non-empty value opts out, `0` and `false` included. Unset it to turn telemetry back on |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Same set-at-all rule, as the wider "no nonessential traffic" switch |

The per-signal OpenTelemetry selectors still work alongside these:
`OTEL_METRICS_EXPORTER=none` silences usage metrics and
`OTEL_LOGS_EXPORTER=none` silences harness events, each without touching the
other.

### Disable switches

| Variable | Set to `1` to |
| --- | --- |
| `NESSY_DISABLE_BACKGROUND_TASKS` | Turn off background tasks, including automatic backgrounding of long-running commands and MCP calls |
| `NESSY_DISABLE_CRON` | Turn off scheduled-task creation and delivery inside sessions |
| `NESSY_DISABLE_WORKFLOWS` | Remove the workflow tool, workflow slash commands, and the keyword trigger |
| `NESSY_DISABLE_BUNDLED_SKILLS` | Drop the bundled skills and workflows that ship with the app; your own skills and plugin skills are unaffected. On a Codex session this also turns off Codex's own bundled skills (`[skills.bundled] enabled = false`), `$skill-installer` among them |

These compose with the matching settings keys tighter-wins: whichever side asks
for off, wins.

### NESSY_LOCAL_MCP_ENABLED

Turns local MCP servers (the stdio-subprocess kind) on or off, taking
precedence over whatever each workspace has configured.

```bash
export NESSY_LOCAL_MCP_ENABLED="false"
```

The value is compared case-insensitively: any value equal to `true` (ignoring
case) enables local MCP servers; anything else disables them. When the variable
is unset, local MCP servers are enabled by default.

### NESSY_PLUGIN_GITLAB_HOSTS

Additional self-hosted GitLab hostnames that [plugin installs](/plugins/overview)
may fetch from. Separate them with commas or whitespace; hostnames are compared
case-insensitively.

```bash
export NESSY_PLUGIN_GITLAB_HOSTS="gitlab.internal.example.com, code.example.net"
```

Each declared host takes the documented GitLab v4 archive route, which is built
from the repository URL's own origin. `gitlab.com`, any hostname with `gitlab` as
a whole DNS label, and this fork's own git host resolve without being declared —
this variable is for the ones whose names do not say GitLab.

It declares **GitLab** hosts only. A GitHub Enterprise Server host cannot be
declared here, deliberately: its archive route would work, but tag resolution is
hard-coded to `api.github.com`, so a declared GHES host would silently resolve
its tags against the wrong server.

An administrator can mandate the list for a whole fleet from the `env` block of
a [managed settings](/reference/config/config-file) policy — the variable is
classified as an immediate managed value, so it is applied at startup and nobody
has to export anything by hand.

### NESSY_MCP_TIMEOUT

The startup deadline for one MCP server connection, in milliseconds. Default:
`30000` (30 seconds). Raise it when a stdio server keeps failing at startup
because its first run is slow — typically while `npx` or `uvx` downloads the
package.

```bash
export NESSY_MCP_TIMEOUT="60000"
```

The value must be a positive integer; anything else falls back to the default.
The deadline budgets the whole initial connect, including all 3 connect
attempts — not each attempt separately — so set it with the full retry chain in
mind. An explicit programmatic connect timeout, where one is configured, takes
precedence over this variable.

### NESSY_STOP_HOOK_BLOCK_CAP

How many times in a row a `Stop` or `SubagentStop` hook's block reason is
re-delivered to the model before it is suppressed and the turn ends anyway.
Default: `8`. Raise it when a hook legitimately needs more iterations to
converge; set `0` to remove the cap entirely.

```bash
export NESSY_STOP_HOOK_BLOCK_CAP="20"
```

The value must be plain digits; anything else falls back to `8`, so a typo
cannot silently produce an uncapped hook loop.
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is accepted as a compatibility alias, and the
Nessy spelling wins when both are set.

### NESSY_MAX_WEB_SEARCHES_PER_SESSION

The most web searches one session can make with the app's own `web_search`
tool. Default: `200`. Past the cap, a search returns a notice telling the model
to continue with what it has already gathered, rather than an error that would
invite a retry.

```bash
export NESSY_MAX_WEB_SEARCHES_PER_SESSION="500"
```

The value must be a positive whole number, with no upper bound; anything else
falls back to `200`, and `0` is not an off switch, so the cap can be raised but
not turned off. `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` is accepted as a
compatibility alias, and the Nessy spelling wins when both are set.

On the **ChatGPT (Codex)** card the model searches with Codex's own web search
instead of the app's tool, and Codex has no per-session limit, so this cap does
not stop it there. The app counts Codex's searches in that session, its
subagents included, and on the first search past the cap says so once in the
chat. See [LLM Connections → ChatGPT (Codex)](/reference/config/llm-connections#chatgpt-codex).

### NESSY_WEB_SEARCH_ALLOWED_DOMAINS

The domains web search may return results from. Unset (the default), search is
not restricted. Separate the entries with commas or whitespace. Web search
itself needs no approval in any mode, on any runtime; a deny rule that names
the search tool turns it off (see [Permissions](/core-concepts/permissions)).

```bash
export NESSY_WEB_SEARCH_ALLOWED_DOMAINS="example.com, docs.python.org"
```

Each entry allows its own host and every subdomain of it: `example.com` allows
`docs.example.com`, but not `notexample.com`. Entries are compared
case-insensitively and may be written as an address: a scheme, a port, a path
and a leading dot are ignored, so `https://Example.com/docs` means
`example.com`. An empty value filters nothing, the same as unset. There is no
`CLAUDE_CODE_` alias: Claude Code has no such variable.

Results outside the list are dropped before the model sees them, and so is a
result whose address cannot be read. When a search had results and every one of
them was dropped, it returns a notice that names this variable and asks the
model to continue with what it has or to ask you to widen the list, rather than
an empty answer.

Where it applies:

- **Pi**: Pi's own `web_search` tool.
- **Claude Code** and **Codex**: the app's own `web_search` tool, which these
  runtimes get where their own search cannot run — on the Nessy Gateway, on a
  custom endpoint reached over chat completions, and on every Codex card except
  ChatGPT (Codex).
- **ChatGPT (Codex)**: the list is handed to Codex's own web search as the
  domains it may use, and Codex applies it by its own matching; the app's
  notice above does not appear there. See
  [LLM Connections → ChatGPT (Codex)](/reference/config/llm-connections#chatgpt-codex).
- **Claude Code's own `WebSearch`**, where a session keeps it — with an
  Anthropic account, or with a model a custom endpoint serves on
  [Anthropic's wire](/reference/config/custom-endpoint#anthropic-wire-models):
  that search runs on the provider's side, so the app scopes each call instead
  of filtering results. Every search is limited to the list through the tool's
  own `allowed_domains` input. A search the model limited to hosts of its own
  keeps only the ones inside the list; when none of them is inside, the search
  is refused with a message that names this variable. The model's own
  excluded domains are dropped from such a call, because Claude Code cannot
  combine the two kinds of list in one search; the results still come only from
  the domains you allowed. The provider matches the domains by its own rules,
  and the notice above does not appear there.

An administrator can set the list for a whole fleet from the `env` block of a
[managed settings](/reference/config/config-file) policy; it is applied at
startup.

### NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT

What a session does when a usage limit stops a turn and the limit's reset time
is known. On (the default), the session waits for the reset and continues the
task; `0` stops the turn instead. Where no reset time was published, the turn
stops whatever this says: the app never guesses one.

```bash
export NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT="0"
```

Accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`; anything else keeps
the default. What each runtime does with it:

- **Claude Code**: the app hands the answer to Claude Code's own
  `autoContinueAtUsageLimit` setting, and Claude Code performs the wait (it does
  not wait while the session is using overage).
- **Codex**: Codex stops at a usage limit and does not continue a stopped turn
  by itself, so here the setting changes only the message. On, it names the
  reset time and asks you to send a message after it; `0` says the turn stops
  rather than waiting.
- **Pi**: does not read it.

### NESSY_IDLE_AGENT_TTL_MS

How long a conversation may sit with no turn started or finished before its
agent runtime is released. Default: `1800000` (30 minutes). Your next message
starts it again and the conversation is intact — what a release costs is the
time to start, not the thread.

```bash
export NESSY_IDLE_AGENT_TTL_MS="600000"
```

`0`, a negative value or anything non-numeric **disables** the release entirely;
that is the off switch, and it is deliberately not spelled as "release
everything". A session holding work is never released regardless of this value —
a running turn, a background task, a background command, a child agent, a
pending permission card or an unanswered question all keep it, as does a session
listening for something it would stop hearing.

### NESSY_IDLE_AGENT_SWEEP_MS

Gap between idle sweeps. Default: `60000` (1 minute). One sweep serves the whole
app rather than a timer per conversation. `0` falls back to the default rather
than busy-looping.

### NESSY_DEBUG

Enable debug logging. Accepts `"true"` or `"1"`.

```bash
export NESSY_DEBUG="true"
```

### NESSY_DEEPLINK_SCHEME

Override the deep-link URL scheme. The default is `nessy` (deep links look like
`nessy://...`). Multi-instance development uses suffixed schemes such as
`nessy1`.

```bash
export NESSY_DEEPLINK_SCHEME="nessy1"
```

### NESSY_BROWSER_DOWNLOAD_DIR / NESSY_BROWSER_DOWNLOAD_ASK

Where a file downloaded in the built-in browser is written. Unset, downloads
keep going to the session's own `downloads` directory with no dialog, exactly as
before.

`NESSY_BROWSER_DOWNLOAD_DIR` takes an ABSOLUTE directory and every download
lands there; a relative value is ignored and logged.
`NESSY_BROWSER_DOWNLOAD_ASK` accepts `1`/`true`/`yes`/`on` and makes the browser
raise the system's own save dialog for each download, starting in the directory
above when one is set.

```bash
export NESSY_BROWSER_DOWNLOAD_DIR="/Users/me/Downloads/nessy"
export NESSY_BROWSER_DOWNLOAD_ASK="1"
```

## Server mode

These configure the [headless server](/server/headless) and its clients.

### NESSY_SERVER_TOKEN

The bearer token that authenticates the RPC link. Both ends — server and
client — must set the same value.

```bash
export NESSY_SERVER_TOKEN=$(openssl rand -hex 32)
```

### NESSY_SERVER_URL

Server URL the client connects to.

```bash
export NESSY_SERVER_URL=wss://your-server:9100
```

### NESSY_RPC_HOST

Interface the server binds to. Left unset it stays on `127.0.0.1`, reachable
only from the local machine; use `0.0.0.0` to let remote clients in.

```bash
export NESSY_RPC_HOST=0.0.0.0
```

### NESSY_RPC_PORT

Server port. Defaults to `9100`.

```bash
export NESSY_RPC_PORT=9100
```

### NESSY_RPC_TLS_CERT / NESSY_RPC_TLS_KEY

Paths to the TLS certificate and its private key, both in PEM form. Remote
(`wss://`) clients need them; a localhost-only dev setup can skip them.

```bash
export NESSY_RPC_TLS_CERT=/path/to/cert.pem
export NESSY_RPC_TLS_KEY=/path/to/key.pem
```

### NESSY_RPC_TLS_CA

Optional PEM CA chain for custom certificate authorities.

```bash
export NESSY_RPC_TLS_CA=/path/to/ca.pem
```

## Networking

### HTTP_PROXY / HTTPS_PROXY / NO_PROXY

Standard proxy variables. Nessy Desktop derives these from the in-app
[network proxy](/reference/config/network-proxy) settings and passes them to
agent subprocesses; the lowercase forms are set as well.

The app also reads them. When the in-app proxy is off, a proxy set here (on
macOS, in your login shell too) carries the app's own requests, including the
model requests of Codex and Claude Code sessions on the gateway and
custom-endpoint cards, and a managed settings `env` block that
sets one takes precedence over the in-app setting — see
[Network Proxy → How it works](/reference/config/network-proxy#how-it-works).

The headless server's `bin/nessy-server` launcher, started with one of these
set, also exports `NO_PROXY` (and `no_proxy`) extended with
`localhost,127.0.0.1,::1,[::1]`. Any entries you set are kept, so the server's
own requests to this machine never go through the proxy. A server started from
a checkout gets no such extension and warns instead — see
[Headless Server → Starting the Server](/server/headless#starting-the-server).

### NODE_EXTRA_CA_CERTS

Point Node-based processes at an additional CA certificate — needed behind a
TLS-intercepting corporate proxy. See
[Network Proxy → TLS-intercepting proxies](/reference/config/network-proxy#tls-intercepting-proxies-corporate-firewalls).

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

## Installer variables

The macOS install script reads these:

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `NESSY_DESKTOP_INSTALL_BASE`   | Base URL of the release feed                           |
| `NESSY_DESKTOP_INSTALL_VERSION`| Pin a specific version to install                      |
| `NESSY_DESKTOP_DOWNLOAD_DIR`   | Where downloaded DMGs are cached (default under `~/.nessy-agent/downloads`) |

## Release and docs tooling

- `NESSY_DESKTOP_UPDATE_URL` and `NESSY_DESKTOP_UPDATE_CHANNEL` feed local
  Electron packaging.
- `NESSY_DESKTOP_DOCS_BUCKET` and `NESSY_DESKTOP_DOCS_URL` override the
  documentation publish target.
- S3 publish credentials are supplied only by protected CI variables on
  protected refs; they are not set by hand.

## Security note

::: warning
Avoid putting secrets directly in shell history or committed scripts. Read them
from a file or a secret manager instead:

```bash
export LLM_API_KEY=$(cat ~/.secrets/llm-key)
```
:::
