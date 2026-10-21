# P2.251 — the claude subprocess projects proxy vars at a loopback URL

**Verdict: IT IS A DEFECT, and it reproduces on the claude path exactly as P2.213 measured it on
codex — same three arms, same shape, same fix.** Unlike P2.213, the row's hypothesis was *not*
inverted here; but one half of the row's framing *was* wrong, and that half is recorded below
(§5) because acting on it would have removed working behaviour.

---

## 1. The rig (built locally; no corporate endpoint was contacted)

`scratchpad/sdd2/rig/three-arms.ts` — one Bun script, three servers, all on 127.0.0.1:

- **stub upstream** — an HTTP server answering `POST /v1/messages` with a minimal but valid
  Anthropic SSE stream (`message_start` … `message_stop`). It stands in for
  `ClaudeAgent.startLocalAdapter`'s per-session loopback adapter. It counts every request it
  receives.
- **sink proxy** — an HTTP server that accepts absolute-form requests and `CONNECT`, records the
  URL/authority, and answers `502`. It stands in for a corporate proxy that cannot reach the
  client's own loopback address, which is what a real one does.
- **subject** — the REAL native binary,
  `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (272 MB Mach-O arm64),
  spawned with `--print --output-format stream-json --verbose`, `ANTHROPIC_BASE_URL` at the stub,
  an isolated `CLAUDE_CONFIG_DIR` and `cwd` per arm, `CLAUDE_CODE_MAX_RETRIES=0`.

Three independent detectors per arm, so no single one has to be trusted: `upstreamHits` (what
the adapter actually received), `sinkHits` (what the proxy actually received), and the SDK's own
`{"type":"result"}` line (`is_error`/`subtype`).

## 2. The measurement

| arm | HTTP(S)_PROXY | NO_PROXY | ANTHROPIC_BASE_URL | turn | upstream hits | sink hits |
| --- | --- | --- | --- | --- | --- | --- |
| A (positive control) | absent | — | `http://127.0.0.1:<p>` | **ok**, exit 0 | `HEAD /api/hello`, `POST /v1/messages?beta=true` | **0** |
| B (hypothesis) | sink | absent | `http://127.0.0.1:<p>` | **FAILED**, exit 1, `is_error:true` | **0** | `ABS POST http://127.0.0.1:60966/v1/messages?beta=true` |
| C (proposed fix) | sink | `localhost,127.0.0.1,::1` | `http://127.0.0.1:<p>` | **ok**, exit 0 | `POST /v1/messages?beta=true` | **0** |
| D (exemption ≠ opt-out) | sink | `localhost,127.0.0.1,::1` | `http://api.nessy-rig.invalid` | fails (as it must) | 0 | `ABS POST http://api.nessy-rig.invalid/v1/messages?beta=true` |

Arm B is the whole finding: with a proxy set and no exemption, **the child POSTs its own loopback
base URL at the proxy**, the adapter is never contacted, and the turn dies. This is the shipped
default for a corporate-proxy user on macOS — `loadShellEnv` copies the entire login shell into
`process.env`, and `buildClaudeSubprocessEnv` spreads `process.env`, so a `.zshrc` `HTTPS_PROXY`
reaches the child whether or not anything projects it. `getProxyEnvVars()` is a *second* way in,
not the only one.

Arm D is the control that makes C an exemption rather than a `no_proxy=*` opt-out: with the
loopback rule in place, genuine non-loopback traffic still goes to the proxy.

Arm A is the positive control demanded for any absence claim (`sinkHits: []` on an arm where the
sink was live and reachable, proven live by arms B and D).

## 3. Two things the binary told us directly

Scanned `strings -a` over the binary (680 854 lines), with controls: `CODEX_CA_CERTIFICATE` → 0,
a made-up `NESSY_TOTALLY_MADE_UP_VAR` → 0.

**(a) The mTLS finding does NOT transfer from codex — it is the opposite shape.** P2.213 measured
`CLAUDE_CODE_CLIENT_CERT/_KEY/_KEY_PASSPHRASE` at **zero** occurrences in the codex binary and
concluded that projecting them there would hand a third party a passphrase it never reads. In the
claude binary they are 13 / 16 / 7, and they appear as *behaviour*, not as dead strings:

```
CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (
client certificate from CLAUDE_CODE_CLIENT_CERT
client key from CLAUDE_CODE_CLIENT_KEY
mTLS: Using client key passphrase
```

`NODE_EXTRA_CA_CERTS` is 36 and likewise live. **So all three components of
`buildNetworkEnvVars` are correct on the claude path and none of them should be withdrawn.** The
projection is not the defect; the missing loopback exemption is.

**(b) The binary reads the lowercase spelling FIRST.** From its own bundled proxy code:
`return new ProxyConfig(proxyUrl, keepAlive, env.no_proxy || env.NO_PROXY)`. Writing only
`NO_PROXY` would be silently ignored whenever the user's shell also exports `no_proxy`. The fix
writes both spellings with the same merged value; a test pins that.

## 4. The fix, and where it lives

The brief asked whether the rule belongs in one shared place. **It does, and the measurement also
says exactly where it cannot go.**

- **It cannot live inside `buildNetworkEnvVars`/`getProxyEnvVars`.** That projection sees the
  in-app Settings proxy only. Arm B's proxy came from the ambient environment with *no* Settings
  proxy configured — a projection-time rule would emit nothing and miss the failing case entirely.
  The decision is only decidable over the **merged** env at a spawn site.
- So the shared unit is a **mutator over the merged env**:
  `applyLoopbackProxyExemption(env)`, exported from
  `packages/shared/src/config/proxy-env.ts` (the file that already owns the subprocess network-env
  contract, and already imports `splitNoProxyEntries` — so no third copy of the NO_PROXY grammar
  is created). `getProxyEnvVars`'s own docblock now names the obligation, so the next spawn site
  pointed at loopback finds the rule from the projection it is already calling.
- **Called from** `buildClaudeSubprocessEnv` (`packages/shared/src/agent/options.ts`), after every
  spread and after `envOverrides`, so an `envOverrides` NO_PROXY is extended rather than
  pre-empted. Placed there rather than at the three Claude spawn sites for the reason the
  `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_DISABLE_CRON` blocks in the same function already give:
  every Claude spawn path reaches the child through this one function, and the defect a second
  copy reproduces is a forgotten call site.
- **codex keeps its own copy** (`applyLoopbackNoProxy`,
  `packages/codex-agent-server/src/runtime-manager.ts` — read-only for this row) because
  `@nessy-agent/shared` already imports that package and importing back would close a cycle. That
  reason is now written on both sides, and both docblocks say the two must change together. The
  shared docblock states that a **fourth** caller belongs in the shared helper, not in a third
  copy.

Semantics, identical to P2.213's: fires **only when a proxy is actually set** (a no-proxy session
keeps a byte-identical env), **extends and never replaces** an existing NO_PROXY, de-duplicates
case-insensitively, accepts both documented NO_PROXY spellings and emits the canonical comma form,
and adds exactly `localhost,127.0.0.1,::1` — never `*`.

## 5. Where the row's framing was wrong

The row says claude-runtime "is more exposed because it projects the vars deliberately rather than
inheriting them". **The deliberate projection is not what makes it exposed.** Arm B was driven by
the *ambient* `process.env` proxy with no Settings proxy at all — the same inheritance path codex
has. The projection adds a second source, not the hazard. The practical consequence: a fix aimed
at the projection (dropping `getProxyEnvVars()` from the builder, the mirror-image of what P2.213
was tempted to add) would have left arm B failing **and** withdrawn the CA and mTLS material the
binary demonstrably does read (§3a). The exposure is the loopback `ANTHROPIC_BASE_URL`, which is
unconditional on `claude-runtime` sessions, and nothing else.

## 6. Scope deliberately not taken

- `needsHttpPoolServer` is `false` for the `anthropic` backend
  (`packages/shared/src/agent/backend/factory.ts`), so the claude child has no loopback MCP pool
  URL; `ANTHROPIC_BASE_URL` is its only loopback route. Codex is the one with both.
- The Pi subprocess, native stdio MCP servers, the headless server's children and supervised
  plugin processes all take `getProxyEnvVars()`/`getPluginNetworkEnvVars()` too, and were **not**
  measured here (out of zone). If any of them is pointed at a loopback URL, the same rule applies
  and the shared helper is ready for it — that is a row, not an assumption.
- **One of those is worth handing over the way P2.213 handed this row over: the Pi path has the
  same shape, and the mechanical halves are confirmed while the outcome is UNMEASURED.**
  `packages/shared/src/agent/pi-agent.ts:2141` merges `...process.env` + `...getProxyEnvVars()`
  into the Pi subprocess env; the Pi interceptor's own bypass
  (`packages/shared/src/unified-network-interceptor.ts:127` `shouldBypassProxy` →
  `getProxyForUrl:144`) honours an explicit NO_PROXY **and exempts loopback nowhere**; and the
  local-model card the product ships defaults to `http://localhost:11434`
  (`apps/electron/src/renderer/components/onboarding/LocalModelStep.tsx:42`, and the
  `onboarding.localModel.endpointPlaceholder` string in both locales). A corporate-proxy user
  running the local Ollama card is therefore in arm B's position by construction. **Not measured
  here — no arm was run against Pi, and P2.213 is the standing proof that this shape can be
  inverted.** Same for `packages/shared/src/mcp/client.ts:509` (native stdio MCP servers), where
  a user-configured loopback server is possible but not shipped by default.

## 7. Evidence

- New tests: `packages/shared/src/agent/__tests__/claude-loopback-proxy-exemption.test.ts` — 8
  tests. Six through `buildClaudeSubprocessEnv` (ambient-shell proxy exempts loopback and writes
  both spellings and not `*`; no proxy → NO_PROXY untouched; `ALL_PROXY` alone fires it; a
  whitespace-only proxy value does not; a user NO_PROXY is extended in place; an `envOverrides`
  NO_PROXY is extended), two directly on the helper's grammar (space-separated spelling →
  canonical comma form; case-insensitive de-duplication across both spellings).
- **Mutation check:** with `applyLoopbackProxyExemption(env)` commented out, the same file went
  **4 pass / 4 fail** — every case that asserts the exemption failed, and the two negative cases
  plus the two direct-helper cases correctly stayed green. The tests are a detector, not a
  description. Call site restored and re-verified afterwards.
- **Typecheck proven to REACH both changed files**, not merely to pass: a
  `const __P2251_PROBE: number = "plant";` planted above each edit produced
  `src/agent/options.ts(323,7): error TS2322` and `src/config/proxy-env.ts(201,7): error TS2322`;
  both probes removed and `typecheck:shared` re-run clean.
- Rig transcript: the four arm JSON blobs above are verbatim from
  `bun scratchpad/sdd2/rig/three-arms.ts`.

## 8. Gate output

- `bun run typecheck:shared` — clean (and proven to reach both files, §7).
- `bun scripts/bun-test-lock.ts run --label P2.251 -- bun test <8 affected files>` —
  **91 pass, 0 fail, 0 skip**, 215 expect() calls, 8 files. Affected set: the new file, the four
  other `buildClaudeSubprocessEnv` env tests (`claude-retry-ceiling`, `claude-subagent-depth`,
  `claude-scheduling-projection`, `workspace-claude-config-dir`), `claude-gateway-adapter`
  (the loopback `ANTHROPIC_BASE_URL` producer), and both `proxy-env` / `network-trust-scope`
  config tests.
- `git diff --check` — clean.
- No entry in `docs/superpowers/specs/2026-07-29-known-failing-tests.md` was touched; nothing in
  the affected set failed, so there is nothing to diff by name.

## 9. Commit

`733d99ce0` on `feat/TCODE-000` — three files, staged strictly by pathspec while three other
lanes had uncommitted work in the same package. Verified after the fact: the commit contains
exactly `packages/shared/src/agent/options.ts`,
`packages/shared/src/config/proxy-env.ts` and the new test; the other lanes'
`codex-agent.ts` / `powershell-validator.ts` modifications and their untracked test files are
untouched, and no phantom revert appeared in the index.
