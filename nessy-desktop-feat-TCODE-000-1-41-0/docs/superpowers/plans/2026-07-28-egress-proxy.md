# Egress Proxy and Domain Policy (R19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn our binary network boundary into a per-domain one: a per-session egress proxy (HTTP CONNECT + SOCKS5) that sandboxed subprocesses must go through, deciding allow/deny/prompt from the sandbox network policy, with first-use approval remembered for the session.

**Why this is a build, not a settings key (the honest shape):** we already ship OS-level isolation — `ProcessIsolationProfile = 'none'|'read-only'|'workspace'|'networked'|'plugin-mcp'|'isolated-code'` (`packages/shared/src/agent/pi-harness/process-supervisor-port.ts:3`) enforced via `sandbox-exec` on macOS and `bwrap`/`firejail`/`unshare` on Linux, with remediation text naming exactly that (`packages/server-core/src/pi-harness/isolation-remediation.ts:33-39`). But network is ALL-OR-NOTHING today: every profile except `networked` denies outbound entirely, and `networked` allows everything. The domain layer has nowhere to live until an egress proxy exists.

**Architecture (verified 2026-07-28 at `6384a3e1`, two independent scouts):**
- Policy inputs already landed by R3: `SandboxNetworkSettingsV1` (`packages/shared/src/config/sandbox-settings.ts:76` — `allowedDomains`, `deniedDomains`, `allowManagedDomainsOnly`; resolved shape `:115`), composed by `resolveSandboxSettings` (`:280`; `allowedDomains` capped by the floor, `allowManagedDomainsOnly` is an OR across layers).
- The SSRF guard is `isDeniedNetworkTarget` (`packages/shared/src/config/network-address-guard.ts:127` — **not :30**), four clauses: literal private/link-local/cloud-metadata, `deniedDomains`, managed allowlist, and a resolved-address re-check. Denies loopback/private/link-local/CGNAT/multicast/IPv6 ULA+LL+multicast and the metadata IPs. Today's only caller is the Monitor ws source (`SessionManager.ts:2281-2287`) — reuse it, do not fork it.
- **The first-use pattern already exists**: session-scoped `isDomainWhitelisted` (`packages/shared/src/agent/core/permission-manager.ts:402`) consumed by the Bash curl/wget check (`pre-tool-use.ts:1578`) — the same "approve → remembered for the rest of the session" shape the docs describe. REUSE it; do not invent a second whitelist.
- Approval surface: prompt-type union at `pre-tool-use.ts:499` (`bash|file_write|mcp_mutation|api_mutation|admin_approval|workflow_launch`); renderer routing precedent in `apps/electron/src/renderer/components/app-shell/input/StructuredInput.tsx:49/:58` (`AdminApprovalRequest`, `WorkflowLaunchRequest`) — R7's commit is the end-to-end template.
- Isolation: `resolveProcessIsolation` (`packages/server-core/src/pi-harness/isolation.ts:68`) dispatches per platform; the macOS wrapper is `wrapBashCommandWithMacosSeatbelt` (`packages/shared/src/agent/core/bash-seatbelt.ts:95` — **note `SEATBELT_TESTING_WILDCARD` at `:63` allows everything during testing; tests must not run under it when asserting the boundary**). Scout finding to confirm in Task 1: **the supervisor itself applies no network constraint** (`process-supervisor.ts:24/:37`) — the "networked vs the rest" distinction may live only in the Linux backend's remediation, i.e. the boundary may not exist on macOS at all today.
- Supervised env: `hostEnvironment` (`process-supervisor.ts:667`) filters by `ProcessEnvironmentProfile` (`process-supervisor-port.ts:4`: `restricted|explicit|trusted-host`) against the `RESTRICTED_HOST_ENVIRONMENT` allowlist (`:644`, plus an `LC_*` pattern `:654`); there is **no mask/deny path for `credentials.envVars` today** — Task 4 adds `deny` there.
- Not this plan: the app's OWN outbound proxy (`apps/electron/src/main/network-proxy.ts:25` `ProtocolProxyDispatcher` on undici, `NetworkProxySettings` `packages/shared/src/config/types.ts:17`, `getProxyEnvVars` `packages/shared/src/config/proxy-env.ts:7`) — that is **R26**, a different boundary. Do not entangle.

**Contract source:** `code.claude.com/docs/en/sandboxing.md` § "Network isolation", § "Protect credentials", § "Custom proxy configuration", § "Security limitations"; `settings.md` § sandbox settings. **R19 has no doc-verification entry** (that sweep covered 22 other units) — the pages ARE the contract here, so quote them in commit bodies.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; no edits to `docs/superpowers/specs/`, the audit, or the CDP checklist; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root.
- **Documented policy semantics, exactly:**
  - No domains pre-allowed by default; the FIRST connection to a new host prompts; an approval holds **for the rest of the session** (docs, v2.1.191+).
  - `allowedDomains` + `WebFetch(domain:…)` ALLOW rules pre-allow (no prompt). `deniedDomains` blocks even when a broader wildcard would allow.
  - `strictAllowlist: true` → DENY instead of prompt. Honored only from user / managed / CLI `--settings`; **a repo's `.claude|.nessy-agent` project settings must be ignored for this key** — test it.
  - `allowManagedDomainsOnly` (managed) → non-allowed domains blocked without prompting, and only managed `allowedDomains`/WebFetch rules count.
  - Wildcards: `*.example.com` matches subdomains; the between-dots rule from WebFetch applies (`example.*` matches `example.org`, never `example.evil.com`).
- **The proxy is the enforcement point, and the OS layer must make it unavoidable.** Binding a proxy the process may ignore is theatre: the sandboxed process must be able to reach ONLY the proxy's loopback port. macOS: the seatbelt profile allows outbound only to that port. Linux: the profile denies network and the relay reaches the proxy (this is what `socat` does upstream). If a platform cannot enforce that, the profile must FAIL CLOSED (no networked-without-enforcement fallback) with a remediation message in the existing `isolation-remediation.ts` style.
- **Loopback bind + per-session credential.** The proxy binds 127.0.0.1 on an ephemeral port, one instance per session, dies with the session; SOCKS5 and CONNECT both require the per-session token/user so another local process cannot borrow the egress. Never bind 0.0.0.0.
- **`credentials.envVars` `mask` is fail-closed in this plan.** Full sentinel→real substitution needs TLS termination, which is a separate build. Land the DOCUMENTED failure: a `mask` entry without `network.tlsTerminate` is reported at startup and the sentinel is what the command sees. `deny` (unset the var for sandboxed commands) DOES land here — it needs no proxy. `mask` entries from project settings are ignored (docs).
- Honest limitation to record in code + plan: the proxy decides from the client-supplied hostname without TLS inspection, so domain fronting is possible — documented upstream, not a defect. Say it where an admin will read it.
- The recurring defect count is FIFTEEN. The chain is policy → proxy → OS profile → supervisor env → approval band → renderer. Assert through production seams; a proxy that unit tests dial directly while the supervisor never routes to it is THE defect. Live re-drive is the planner's pass 14.
- i18n for renderer strings; new prompt-type card gets a playground state (playground-design-surface rule).

---

### Task 0: Pre-phase

R18 pass-13 leftovers: none routed here (SO-2/SO-3 are gateway-blocked live rows). Confirm in one paragraph in this plan file; fold in any newly routed defect.

- [ ] **Step 1:** Confirm/record.

### Task 1: Re-verify the plan against current code

- [ ] **Step 1:** Re-check every anchor on HEAD; correct drifts here; record in Task 2's commit body. Specifically answer IN THIS FILE: (a) what exactly the `networked` profile permits today on macOS and on Linux (quote the profile/argv construction), and whether either can be narrowed to a single loopback port; (b) whether `plugin-mcp`/`isolated-code` also need the proxy or are out of scope; (c) how supervised-process env is assembled (the allowlist) so `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` can be injected.

### Task 2: The domain-policy engine (pure)

**Files:** new `packages/shared/src/egress/policy.ts` (+ tests); consumes `SandboxNetworkSettingsV1`, the WebFetch allow-rule source, and the session whitelist
- Test: table-driven over the documented semantics

- `decide(host, port, ctx) → 'allow' | 'deny' | 'prompt'` with precedence: deniedDomains > (strictAllowlist|allowManagedDomainsOnly → deny) > allowedDomains/WebFetch-allow/session-approved > prompt.
- Wildcard matching incl. the between-dots rule; case-insensitive; trailing-dot stripped.
- Layer honesty: `strictAllowlist` and `mask` read from user/managed/CLI only — project layers ignored.

- [ ] **Step 1:** Failing tests: each precedence row; `*.example.com` sub/exact; `example.*` never matching `example.evil.com`; project-layer `strictAllowlist` ignored while user-layer wins; `allowManagedDomainsOnly` drops non-managed allows; a session-approved host stops prompting; `isDeniedNetworkTarget` targets always deny regardless of allows.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(egress): the domain policy engine`

### Task 3: The per-session egress proxy

**Files:** new `packages/server-core/src/egress/` (proxy server: HTTP CONNECT + SOCKS5, loopback, per-session token, lifecycle bound to the session), consuming Task 2
- Test: real sockets against a local origin server (no network)

- CONNECT and SOCKS5 both: authenticate the per-session credential, resolve the target, ask the policy, then tunnel or refuse with a distinguishable error (`403`-style for CONNECT, SOCKS5 reply code for the other).
- `prompt` decisions suspend the connection while the approval is pending; approval → session whitelist (the EXISTING one) → tunnel; denial → refuse.
- Lifecycle: one proxy per session, dies with it; never binds beyond loopback.

- [ ] **Step 1:** Failing tests: an allowed host tunnels through CONNECT and through SOCKS5; a denied host is refused with the right protocol error on both; a wrong/absent token is rejected; a prompt decision blocks until resolved then tunnels; the proxy is gone after session dispose.
- [ ] **Step 2:** Implement. Commit: `feat(egress): per-session CONNECT and SOCKS5 proxy`

### Task 4: Make the proxy unavoidable + wire the supervisor

**Files:** the isolation profiles (macOS seatbelt profile text / Linux argv), `process-supervisor.ts` env assembly, remediation messages
- Test: through the REAL supervisor with a real spawned process

- The `networked` profile narrows to "outbound only to the proxy's loopback port"; `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (+ `NO_PROXY` for loopback) injected into the allowlisted env.
- A platform that cannot enforce the narrowing FAILS CLOSED with a remediation message in the existing style — no silent unrestricted fallback.
- `credentials.envVars` `deny` lands here (var unset for sandboxed commands); `mask` without `tlsTerminate` reports the documented startup misconfiguration and leaves the sentinel.

- [ ] **Step 1:** Failing tests: a real sandboxed command reaching an allowed host succeeds THROUGH the proxy (assert the proxy saw the connection — the production path, not a dialled unit); the same command to a denied host fails with the policy error; direct egress bypassing the proxy is impossible (attempt a raw connection to the origin port and assert refusal); a `deny` env var is absent inside the command; `mask` without `tlsTerminate` surfaces the named misconfiguration.
- [ ] **Step 2:** Implement. Commit: `feat(egress): enforce proxy-only egress in the sandbox profiles`

### Task 5: First-use approval through the permission band

**Files:** a new prompt type end-to-end (R7's `workflow_launch` precedent: type unions + strict runtime envelope enum + renderer card + playground + i18n), the pending-connection bridge from Task 3
- Test: through the production `handleAgentPermissionRequest` → response seam (the R7 lesson), plus a renderer card test

- The card names the host and the command that wants it; controls: allow once for this session / deny. (No "always" persistence in this plan — the docs' contract is session-scoped; a durable allowlist is `allowedDomains`.)
- Denial refuses the connection; approval populates the SESSION whitelist so later connections to the same host never prompt.

- [ ] **Step 1:** Failing tests: a prompt decision raises the band with host+command; approval tunnels and the second connection does NOT prompt; denial refuses; the card renders its own template (not a fallback).
- [ ] **Step 2:** Implement. Commit: `feat(egress): first-use domain approval through the permission band`

### Task 6: Close-out

- [ ] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, server-core + pi-agent-server + electron-affected suites, `bun run lint`, i18n parity+sorted, `git diff --check`; if any tool schema text changed — the live-composition pin guard + restaged bundles (R10's lesson).
- [ ] **Step 2:** Mutation probes: (a) let `deniedDomains` lose to a wildcard allow → the precedence test must fail; (b) honor project-layer `strictAllowlist` → the layer test must fail; (c) widen the profile back to full network → the bypass-impossible test must fail; (d) auto-approve a prompt decision without the band → the approval test must fail. Restore all four.
- [ ] **Step 3:** Report: per-task shas, real gate numbers, anchor corrections (esp. the Task 1 answers), deviations, probe results, and the live/CDP cases for the planner's pass 14 — expected: a live sandboxed command to an unapproved host raises the card; approving lets it through and the next call is silent; a `deniedDomains` host is refused even with a matching wildcard allow; with the profile narrowed, a direct-to-origin attempt fails.
