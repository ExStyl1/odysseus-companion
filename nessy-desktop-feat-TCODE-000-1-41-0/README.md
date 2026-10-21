# Nessy Desktop

Nessy Desktop is the T-Bank desktop agent client. It keeps the upstream agent workspace model, Electron UI, headless server, CLI, and source/skill system, while defaulting the first-run LLM path to the internal OpenAI-compatible gateway through the Pi backend.

## Development

Requirements:

- macOS for Electron desktop development and packaging rehearsal.
- Bun 1.3.x.
- Node-compatible shell environment.

Install and run:

```bash
bun install
bun run electron:dev
```

Common checks:

```bash
bun run typecheck:all
bun run lint
bun run test:shared:all
bun test
bun run lint:i18n:parity
bun run lint:i18n:sorted
```

Build the Electron app:

```bash
bun run electron:build
```

For local unsigned packaging, electron-builder requires update placeholders:

```bash
export NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev
export NESSY_DESKTOP_UPDATE_CHANNEL=dev
bun run electron:dist:dev:mac
```

Release jobs set `NESSY_DESKTOP_UPDATE_URL="$NESSY_DESKTOP_DEV_UPDATE_URL"` and `NESSY_DESKTOP_UPDATE_CHANNEL=dev`.

## Internal Gateway

The default connection is `pi_compat`, routed through the internal OpenAI-compatible gateway by the Pi backend. The gateway credentials are not committed.

JWT source:

```text
~/.nessy/dp_auth_creds.json
field: jwt
```

That file is local and read-only for this repo. To rotate the credential, paste the fresh JWT into the Nessy Desktop Settings connection for the internal gateway. The existing local JWT observed during the replatform work was valid until about April 2028, but the Settings value is the runtime source of truth after rotation.

Subscription connections are intentionally kept: Claude Max/Pro OAuth, Anthropic API key, and ChatGPT Plus/Codex OAuth. The removed GitHub subscription surface stays absent.

## Headless Server And CLI

Start a local headless server:

```bash
NESSY_SERVER_TOKEN=$(openssl rand -hex 32) bun run packages/server/src/index.ts
```

Useful server variables:

| Variable | Purpose |
| --- | --- |
| `NESSY_SERVER_TOKEN` | Bearer token for desktop/CLI clients. |
| `NESSY_RPC_HOST` | Bind address, default `127.0.0.1`. |
| `NESSY_RPC_PORT` | Bind port, default `9100`. |
| `NESSY_RPC_TLS_CERT` | Optional PEM certificate for `wss://`. |
| `NESSY_RPC_TLS_KEY` | Optional PEM private key for `wss://`. |

Run the CLI from the monorepo:

```bash
bun run apps/cli/src/index.ts --help
```

## Repo Workflow

Use GitLab merge requests for integration:

1. Work on a feature branch and push it.
2. Wait for the branch pipeline to pass.
3. Open a merge request with the implemented scope, verification output, and known deferred items.
4. Do not create release tags from feature branches.

Protected-ref release secrets do not exist on ordinary branch pipelines. Signed release and publish verification happen only from a protected ref after review.

## Project Layout

| Path | Purpose |
| --- | --- |
| `apps/electron` | Desktop app, Electron main/renderer, packaging config. |
| `apps/cli` | CLI client for the headless server. |
| `packages/server` | Headless server entrypoint. |
| `packages/server-core` | Shared server/session/RPC implementation. |
| `packages/shared` | Config, auth, agent, sources, sessions, i18n, and shared utilities. |
| `packages/ui` | Shared React UI components. |
| `docs/current-plans` | Binding replatform execution plans and trackers. |

## Local Data

Nessy Desktop stores app data under:

```text
~/.nessy-agent/
```

The `NESSY_CONFIG_DIR` environment variable is still supported for development and multi-instance runs.
