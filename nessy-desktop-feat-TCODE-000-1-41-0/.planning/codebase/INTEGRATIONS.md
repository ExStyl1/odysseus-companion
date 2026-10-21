# External Integrations

**Analysis Date:** 2026-08-16

## APIs & External Services

**Nessy Gateway (T-Bank Nestor) — the built-in default:**
- Base URL: `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`
- Models endpoint: `https://code-completion-nestor.tcsbank.ru/api/v1/cli/models`
- Auth header: `Nestor-Token: <JWT>` — attached ONLY when the connection base URL matches the verified gateway prefix (`isNessyGatewayBaseUrl` / `isNestorConnection`, `packages/server-core/src/model-fetchers/nestor.ts`, `packages/shared/src/unified-network-interceptor.ts`)
- Default coder model: `tgpt/qwen35-397b-a17b-fp8`
- Request rewriting: `packages/shared/src/unified-network-interceptor.ts` (+ `interceptor-request-utils.ts`); tests in `packages/shared/src/__tests__/unified-network-interceptor.nestor-auth.test.ts`

**LLM providers:**
- Anthropic — `https://api.anthropic.com` via `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk`; model fetcher `packages/server-core/src/model-fetchers/anthropic.ts`
- OpenAI / Codex — `openai` SDK plus in-repo Responses translation (`packages/codex-responses-adapter/src/config-writer.ts`, `packages/codex-agent-server`)
- OpenAI-compatible endpoints (BYO, incl. local Ollama) — `packages/server-core/src/model-fetchers/openai-compat.ts`
- AWS Bedrock / Google Vertex — `packages/server-core/src/model-fetchers/bedrock-vertex.ts`
- Pi — `packages/server-core/src/model-fetchers/pi.ts`, runtime in `packages/pi-agent-server`
- Internal T-Tech LLM proxy — `https://llm-proxy.t-tech.team` (referenced in `packages/shared/src`)
- GitHub Copilot — `@github/copilot-sdk`

**Claude Code (Nessy Gateway) runtime:**
- Slug `claude-gateway`, providerType `claude-runtime`
- Runs the Claude Agent SDK against the gateway through a per-session loopback adapter translating Anthropic Messages → gateway API (`packages/shared/src/agent/`, tests `claude-gateway-adapter.test.ts`)

**MCP servers:**
- Client + bundled server via `@modelcontextprotocol/sdk`: `packages/session-mcp-server`, `packages/shared/src/mcp/`
- Remote MCP endpoints are user-configured; Figma's `https://mcp.figma.com/mcp` appears in fixtures/live checks

**Marketplaces / registries:**
- Skills market — `https://skills-market.t-tech.team/api` (`packages/shared/src/marketplace/`)
- Plugin catalogues sourced from GitLab (`https://gitlab.tcsbank.ru/api/v4/projects/...`) and GitHub plugin repos
- npm registry proxied through `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all`

**Search / web tools:**
- DuckDuckGo via `duck-duck-scrape`, HTML→Markdown via `turndown` / `markitdown-js` (`packages/pi-agent-server`)

## Data Storage

**Databases:**
- No SQL database. All persistence is the local filesystem.

**File Storage:**
- Local only. Sessions are JSONL + a v2 store under the user config dir: `packages/shared/src/sessions/jsonl.ts`, `store-v2.ts`, `storage.ts`, `persistence-queue.ts`, `bundle.ts`
- Checkpoints and retention: `file-checkpoints.ts`, `checkpoint-gc.ts`, `retention-sweep.ts`
- Config dir: `~/.nessy-agent/` (overridable with `NESSY_CONFIG_DIR`); cache dir via `NESSY_CACHE_DIR`
- Release artifacts published to S3 (`@aws-sdk/client-s3`, `.gitlab-ci.yml` publish stage using `ci-aws` image)

**Caching:**
- In-process `@isaacs/ttlcache`; model catalogue cache persisted in `~/.nessy/dp_auth_creds.json` (`cachedModels`)

## Authentication & Identity

**One-click gateway auth (`dp`):**
- `packages/shared/src/auth/dp/` — `dp-api.ts`, `dp-binary.ts`, `dp-runtime.ts`, `exchange.ts`, `jwt.ts`, `session-broker.ts`, `creds-store.ts`, `env-token.ts`
- Writes `~/.nessy/dp_auth_creds.json` (shape `jwt/expiresAt/username/userId/cachedModels?`, shared with nessy-cli). `creds-store.ts` is the ONLY writer: atomic write, mode 0600, merge-preserves unknown keys. All other code treats the file as read-only.

**OAuth flows:**
- Claude Pro/Max — `packages/shared/src/auth/claude-oauth.ts`, `claude-oauth-config.ts`, `claude-token.ts`
- ChatGPT/Codex — `chatgpt-oauth.ts`, `chatgpt-oauth-config.ts`
- Google — `google-oauth.ts` (scope `https://www.googleapis.com/auth/userinfo.email`)
- Generic/endpoint/MCP OAuth with PKCE and RFC 8414/9728 discovery (`.well-known/oauth-authorization-server`, `.well-known/oauth-protected-resource`) — `generic-oauth.ts`, `endpoint-oauth.ts`, `pkce.ts`, `oauth-flow-store.ts`, `state.ts`
- Loopback callback server + page: `callback-server.ts`, `callback-page.ts`

**Credential storage:**
- `packages/shared/src/credentials/manager.ts` with pluggable backends
- `backends/secure-storage.ts` — AES-256-GCM encrypted file `~/.nessy-agent/credentials.enc`; key derived by PBKDF2 from the OS hardware UUID (macOS `IOPlatformUUID`, Windows `MachineGuid`, Linux `/var/lib/dbus/machine-id`)
- `backends/env.ts` — env-var backed credentials

**Device pairing:**
- `packages/shared/src/pairing/` — pairs the iOS/mobile client with a desktop/server instance; `qrcode.react` renders the pairing code

## Monitoring & Observability

**Error Tracking:**
- No third-party error tracker (no Sentry/Bugsnag).

**Telemetry / metrics:**
- `packages/shared/src/telemetry/` — `usage-metrics.ts`, `cost-reporting.ts`, `gateway-headers.ts` (token/cost accounting, gateway attribution headers)
- Datadog intake URL `https://api.datadoghq.com/` appears in the shared sources as an egress/allowlist reference

**Logs:**
- `electron-log` in the desktop app (`~/Library/Logs/Nessy Desktop/main.log` on macOS; tailed by `scripts/tail-electron-logs.sh`)
- Diagnostics bundle: `packages/shared/src/diagnostics/`

## CI/CD & Deployment

**Hosting:**
- Desktop artifacts + docs site published to S3 through GitLab CI (`docker-hosted.artifactory.tcsbank.ru/ded-dms/ci-aws:latest`)
- Update feed: generic provider at `${NESSY_DESKTOP_UPDATE_URL}` (`apps/electron/electron-builder.yml`), consumed by `electron-updater`

**CI Pipeline:**
- GitLab CI — `.gitlab-ci.yml` with stages install → lint → test → build → release → publish; jobs `install-bun`, `typecheck`, `lint`, `test`, `build-desktop`, `build-ios`, `build-ios-adhoc`, `apphub-upload`, `release-macos`, `publish-macos-dev`, `build-docs`, `publish-docs-dev`
- Compliance/security overlays: `.gitlab-ci-compliance.yml`, `policy.yml`, `semgrep-sast`
- Signing/notarization/AppHub upload via `fastlane/Fastfile` and `fastlane/match.yml`

## Environment Configuration

**Required env vars (representative):**
- `NESSY_DESKTOP_UPDATE_URL` — auto-update feed base
- `NESSY_CONFIG_DIR`, `NESSY_CACHE_DIR`, `NESSY_BUNDLED_ASSETS_ROOT`, `NESSY_WEBUI_DIR`, `NESSY_WEBUI_PORT`
- Feature flags `NESSY_FEATURE_PROVIDER_*`, `NESSY_FEATURE_CODEX_RUNTIME`, `NESSY_FEATURE_CLAUDE_RUNTIME`
- Signing: `CSC_IDENTITY_AUTO_DISCOVERY` and Fastlane/match secrets (protected refs only)
- CI secrets for S3 publishing and Artifactory access

**Secrets location:**
- `.env.example` (template) and `.env.local` exist at repo root — contents not read here
- Runtime credentials: `~/.nessy-agent/credentials.enc` (encrypted) and `~/.nessy/dp_auth_creds.json` (mode 0600)
- CI secrets: GitLab protected variables; code-signing identities via Fastlane match
- `scripts/sync-secrets.sh` pulls developer secrets locally

## Webhooks & Callbacks

**Incoming:**
- Loopback OAuth callback HTTP server on localhost (`packages/shared/src/auth/callback-server.ts`) — the only inbound listener besides the local websocket server (`packages/server`, `ws`)

**Outgoing:**
- Agent hook processes may POST to user-configured URLs (hook contracts in `packages/shared/src/plugins/`); no product-owned outbound webhook endpoints

---

*Integration audit: 2026-08-16*
