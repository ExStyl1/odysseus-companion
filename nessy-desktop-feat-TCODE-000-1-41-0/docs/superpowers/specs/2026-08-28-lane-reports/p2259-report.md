# P2.259 — the Pi subprocess loopback trap, measured end to end

**Status: DONE. SHA `86a4686ba`** on `feat/TCODE-000` — four files, 275 insertions / 21 deletions:
`packages/shared/src/agent/pi-agent.ts`, `packages/shared/src/config/proxy-env.ts`,
`packages/codex-agent-server/src/runtime-manager.ts`, and the new
`packages/shared/src/agent/__tests__/pi-loopback-proxy-exemption.test.ts`.
Verified with `git show --stat` after the commit, not `git diff --cached`. The marker
`buildPiSubprocessEnv` is **absent at `86a4686ba~1`** and present at `86a4686ba`, so it
discriminates.

Branch `feat/TCODE-000`. Everything below was measured locally on one rig; no corporate endpoint
was contacted. Rig sources live in
`/private/tmp/claude-503/-Users-i-i-gavrikov-Desktop-work-nessy-desktop/867097f9-7afb-4480-a5d3-bfe33087163c/scratchpad/sdd2/rig/`
(`p2259-rig.ts`, `bun-native-proxy-probe.ts`, `host-loopback-probe.ts`, `env-trap-probe.ts`).

## Verdict in one line

**The defect is real end to end, it does NOT invert, and the fix is the sibling's fix — but the
row's mechanical framing about WHERE it lives is wrong in a way that would have produced an inert
patch.**

---

## 1. The rig-trap remedy I used (P2.261)

Reproduced first, on this machine, before writing any arm:

```
{"bun":"1.3.14","direct_read":"http://127.0.0.1:9/","in_keys":false,"in_spread":false,
 "arbitrary_in_spread":true,"shell_inherited_check":true}
{"delete_then_assign_in_spread":true,"value":"http://127.0.0.1:9/"}
```

All three boundaries hold exactly as P2.251's review recorded them.

**Remedy used: neither of the two named — a third, strictly stronger one, plus a per-arm positive
control.** The rig **never assigns a proxy variable on `process.env` at all**. Each arm builds the
child env as a plain object (ambient env, filtered of every proxy spelling, then the arm's variables
written onto the object), which is the same thing the child would see from a shell export but with
no runtime assignment anywhere. My login shell carries no proxy variables (verified), so the
filtered base is a no-op in practice.

Because "I avoided the trap" is exactly the kind of claim the trap defeats, **every arm additionally
spawns a throwaway Bun child from the SAME env object and reads `HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY` / `no_proxy` back out of it.** Those readings are printed with every arm below. An arm
that silently lost its proxy would show `null` there and be visible as a rig fault rather than as a
pass.

---

## 2. The four arms, plus two the row did not ask for

Real bundled `packages/pi-agent-server/dist/index.js`, spawned the way `pi-agent.ts` spawns it
(`bun --require <unified-network-interceptor.ts> <server>`), driven over the real JSONL stdio
protocol (`init` → `prompt` → `agent_end`). Upstream is a local OpenAI-compatible SSE stub; the
proxy is a locally built sink that records every request and answers 502.

Three independent detectors per arm: **stub-upstream hits / sink-proxy hits / the turn's own
`agent_end` carrying the stub's marker string**.

| arm | proxy | `NO_PROXY` / `no_proxy` | base URL | turn | stub | sink |
| --- | --- | --- | --- | --- | --- | --- |
| A | — | — | `localhost:<stub>` | **ok** | 1 | 0 |
| B | sink | absent / absent | `localhost:<stub>` | **FAILED** | 0 | 1 — `POST http://localhost:<stub>/v1/chat/completions` |
| C | sink | loopback / loopback | `localhost:<stub>` | **ok** | 1 | 0 |
| D | sink | loopback / loopback | `api.p2259-upstream.invalid` | FAILED | 0 | 1 — `POST http://api.p2259-upstream.invalid/v1/chat/completions` |
| E | sink | loopback / `example.invalid` | `localhost:<stub>` | **FAILED** | 0 | 1 — the loopback POST |
| F | sink | `example.invalid` / loopback | `localhost:<stub>` | **ok** | 1 | 0 |

- **A** is the positive control and it holds.
- **B is the shipped default for a corporate-proxy user.** `onboarding.localModel.endpointPlaceholder`
  is `http://localhost:11434` in both locales, so an Ollama session is in row B by construction.
- **D** is what makes this an exemption and not `no_proxy=*`: genuine non-loopback traffic still goes
  through the proxy.
- **E and F are the pair that decided the design** — see §3.

---

## 3. Two findings that change the fix, neither reachable by reading

### 3.1 The interceptor's `shouldBypassProxy` is NOT authoritative — a fix written there is inert

The row (and the helper's own docblock) names `unified-network-interceptor.ts:127`'s
`shouldBypassProxy` as a place that "exempts loopback nowhere". True, and **irrelevant**: fixing it
would not have fixed anything.

Measured with a bare Bun child and **no interceptor at all** (`bun-native-proxy-probe.ts`, arm N1):
a plain `fetch('http://localhost:<stub>/probe')` with `HTTP_PROXY`/`HTTPS_PROXY` set and no
`NO_PROXY` lands on the **sink**, not the stub. Bun's native fetch re-reads the proxy variables per
request. That is written in `config/network-runtime.ts`'s own header docblock, and it is what makes
the interceptor's decision unenforceable in the "go direct" direction: when the interceptor decides
to bypass it simply omits `init.proxy`, and Bun proxies the request anyway.

**Arm E is the end-to-end proof of that in the real subprocess.** In arm E the interceptor's own rule
(`NO_PROXY || no_proxy`, uppercase first) reads `localhost,127.0.0.1,::1` and says BYPASS — and the
sink still receives the loopback POST and the turn dies. The interceptor asked for direct and did not
get it.

So: **the env is the only lever.** I deliberately did **not** add a loopback rule to the
interceptor's `shouldBypassProxy` — it would be dead code that reads like a fix.

### 3.2 Bun reads `no_proxy` BEFORE `NO_PROXY` — the same precedence as the claude binary

`bun-native-proxy-probe.ts`, six arms, sink/stub detectors:

| arm | `NO_PROXY` | `no_proxy` | result |
| --- | --- | --- | --- |
| N1 | — | — | sink (proxied) |
| N2 | loopback | — | stub (direct) |
| N3 | — | loopback | stub (direct) |
| N4 | loopback | `example.invalid` | **sink (proxied)** |
| N5 | `example.invalid` | loopback | **stub (direct)** |
| N6 | loopback | loopback | stub (direct) |

N4/N5 pin the precedence: **lowercase wins**. Arms E and F reproduce it end to end through the real
Pi subprocess.

This is the **opposite** of the interceptor's own `NO_PROXY || no_proxy`, and it means an
uppercase-only exemption is silently overridden by any shell exporting the lowercase spelling.
P2.251 proved "both spellings" against the claude binary; it is now proven against a **second,
independent reader**, which is the one that actually routes Pi. `applyLoopbackProxyExemption` already
writes both — this is why that is not cosmetic.

### 3.3 Did it invert, the way P2.213 did?

**No.** P2.213 inverted because the obvious fix there was *adding* a projection, and the projection
was the harm. Here the obvious fix is *subtracting* proxy reach from loopback, which the arms confirm
is exactly right, and D/R3 confirm it stays narrow. The thing that would have been wrong here is a
different one — fixing the surface the row names (§3.1) — and that would have failed silently rather
than regressed.

Three doc/row claims the measurements DO correct, none fatal:
- `config/network-runtime.ts`'s header docblock lists what Bun honours as
  "`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, re-read on every request". Correct but
  under-specified in the direction that bites: **`no_proxy` is also honoured and it WINS** over the
  uppercase spelling (§3.2). Not edited — that file is outside my zone and is the fifth surface's
  own file.
- the row treats the interceptor's `shouldBypassProxy` as one of the "three mechanical halves" of the
  defect. It is a mechanical fact but **not a cause**, per §3.1.
- `packages/shared/AGENTS.md` says the interceptor "preloads into the Pi subprocess via Bun
  `--preload`". `pi-agent.ts` passes `--require`. Both work in Bun; the doc line is stale. Not
  touched (AGENTS.md is out of scope for me).

---

## 4. The fix, and the arms that prove it through the real code

`packages/shared/src/agent/pi-agent.ts` — the inline spawn env is now an exported pure builder,
`buildPiSubprocessEnv`, which applies `applyLoopbackProxyExemption` (the shared helper P2.251 landed —
**reused, not copied**) to the **merged** env after every spread including `envOverrides`.

Why the merged env and not `buildNetworkEnvVars`, restated because it is the trap the sibling row hit:
that projection sees the in-app Settings proxy alone, and **the failing arm's proxy is ambient** —
a `HTTPS_PROXY` from the login shell, which `loadShellEnv` copies in wholesale on macOS packaged
builds. A projection-time rule would miss the shipped case entirely.

Four more arms, with the child env built by the **real** `buildPiSubprocessEnv` rather than by hand:

| arm | setup | turn | stub | sink |
| --- | --- | --- | --- | --- |
| R1 | ambient proxy, real builder | **ok** | 1 | 0 |
| R2 | ambient proxy **plus** ambient `no_proxy=example.invalid` (arm E's killer) | **ok** | 1 | 0 |
| R3 | ambient proxy, real builder, NON-loopback base URL | FAILED | 0 | 1 — the `.invalid` POST |
| R4 | no proxy, real builder | **ok** | 1 | 0 |

R2 is the regression arm that matters: the real builder **extends** the ambient lowercase rule
(`no_proxy` becomes `example.invalid,localhost,127.0.0.1,::1`, both spellings), so the exact
configuration that killed arm E now passes. R4 shows the env is untouched when no proxy is set.

**The one behaviour this deliberately removes**, named rather than discovered later: a developer who
points `HTTP_PROXY` at a local inspection proxy (Charles/Proxyman on `127.0.0.1:8888`) to watch
traffic will no longer see the Pi subprocess's **loopback-destined** requests there. Its real
upstream traffic still goes through. This is the same trade-off P2.213 and P2.251 already accepted on
the other two runtimes, so accepting it here keeps the three consistent rather than introducing a new
one.

**Blast radius, in our favour:** the exemption is on the Pi child's env, so every process Pi launches
inherits it — including its own MCP children and anything the model runs through `Bash`. The Pi
subprocess's own callback server binds `127.0.0.1`, so that is the direction we want.

---

## 5. The fifth surface — MEASURED, and rowed rather than taken

`config/network-proxy-utils.ts` `shouldBypassProxy` (`rules.length === 0 → false`) exempts loopback
nowhere, and governs the HOST's own requests via `config/network-runtime.ts` and
`apps/electron/src/main/network-proxy.ts`.

**It is a live defect on the same shipped card** (`host-loopback-probe.ts`, real
`applyProcessNetworkTrustChain`, Settings proxy enabled, no `noProxy`):

```
url    : http://localhost:<stub>/v1/models      <- the local-model card's model list
result : status=502 body=SINK
sink   : [{ "method": "GET", "url": "http://localhost:<stub>/v1/models" }]
stub   : []
```

**Not taken here, and the reason is not scope alone:**

1. It is **two** mechanisms, not one. Besides the resolver, `projectProxyEnv` writes the proxy into
   the host's own `process.env`, and Bun's native fetch re-reads it per request (§3.1) — so a rule in
   `shouldBypassProxy` alone would leave the second route unexempted. Fixing it means changing
   `network-runtime.ts` and, for the Electron main dispatcher, `apps/electron/src/main/network-proxy.ts`.
2. `shouldBypassProxy` is a shared pure function with its own tests and callers that pass
   user-authored rules. `rules.length === 0 → false` is load-bearing for them. Auto-exempting loopback
   there is a **policy** change — it silently overrides an administrator who wrote an explicit
   `noProxy` list that deliberately omits loopback — and deserves its own arms and its own decision,
   not a rider on a Pi fix.
3. Its blast radius is the app's whole egress, including the corporate gateway; my zone is the Pi
   subprocess.

Recommended row text is in §8.

## 5b. `mcp/client.ts:509` — left alone, deliberately

The row calls it lower priority "no shipped default". Confirmed by inspection only: it spreads
`getProxyEnvVars()` into user-configured stdio MCP servers. Not measured, not touched. Our own
session/bridge MCP servers are children of the Pi subprocess and therefore already inherit the
exemption from §4.

---

## 6. Owed comment, paid — and in both directions

`packages/codex-agent-server/src/runtime-manager.ts` now names its twin
(`applyLoopbackProxyExemption`) and both of that helper's callers, so an editor on either side learns
the other exists.

Two things in that same docblock were **stale and are now corrected** rather than left to mislead:
it claimed "Nothing in this repo exempts loopback anywhere else — not `network-proxy-utils.ts`
`shouldBypassProxy`, not the Pi interceptor's `getProxyForUrl`." Half of that is no longer true
(P2.251 and this row are two exemptions), and the half that is still true is now stated as the open
host-side row instead of as a general absence.

`packages/shared/src/config/proxy-env.ts`'s docblock gains: the reciprocal note, its three callers,
the two-independent-readers evidence for the lowercase precedence, and the measured host-surface
sentence.

---

## 7. Verification

- New test file `packages/shared/src/agent/__tests__/pi-loopback-proxy-exemption.test.ts`:
  **9 pass / 0 skip / 0 fail**, 27 assertions.
- **It is a detector**: with `applyLoopbackProxyExemption(env)` commented out at the call site,
  **4 pass / 0 skip / 5 fail**. The 4 survivors are the two negative cases (no proxy; empty proxy
  value) and the two structural ones, which is the correct split.
- `bun run typecheck:shared` → **exit 0**.
- Typecheck proven to REACH all three changed source files by a planted-then-reverted `TS2322` in
  each: `src/agent/pi-agent.ts(241,7)`, `src/config/proxy-env.ts(221,7)`,
  `../codex-agent-server/src/runtime-manager.ts(197,7)`. (`codex-agent-server` has no typecheck script
  and is not in `typecheck:all`; it is covered transitively because `shared/src/agent/codex-agent.ts`
  imports it — the planted error is the proof.)
- `git diff --check` clean on all changed paths.
- `typecheck:shared` re-run after the final docblock edits: **exit 0** again.
- **Not run, and why:** the three-file locked run of
  `pi-loopback-proxy-exemption` + `claude-loopback-proxy-exemption` +
  `config/__tests__/proxy-env.test.ts` was queued behind another lane
  (`P2.226-wave`) holding the mutex for 20+ minutes with 24 waiters behind it. **I cancelled my own
  waiter** rather than add to the queue — the mutex itself was never reaped and the holder was never
  touched. It was never required: the `proxy-env.ts` diff is **docblock-only** — every changed line
  is inside a block comment, confirmed on the hunk-level diff — so no sibling contract could move.
- Mid-run, `typecheck:shared` reported two `TS2741` errors in
  `packages/shared/src/agent/claude-managed-settings.ts` (a `withheld` property added to
  `ClaudeManagedSettingsMappingV1` without updating two return sites). **Another lane's in-flight
  working-tree state, not mine** — attributed to their hunk `@@ -166,0 +191,6 @@`, and gone by the
  time I re-ran. Recorded because a reader of an interim log would otherwise attribute them here.

---

## 8. For the controller — row text I could not write myself (plan file is off-limits to me)

> **P2.26x | the HOST's own loopback requests are proxied too, and it is the same shipped card**
> Named but not taken by P2.259, and **no longer a hypothesis**. Measured 2026-08-27 through the real
> `applyProcessNetworkTrustChain`: Settings proxy enabled, no `noProxy`, and the host's own fetch of
> `http://localhost:<port>/v1/models` — the local-model card's model list — lands on the sink proxy
> with the local server getting **0 hits**. Two mechanisms need the exemption, not one:
> `network-proxy-utils.ts` `shouldBypassProxy` (`rules.length === 0 → false`, reached from
> `config/network-runtime.ts:proxyForUrl` and `apps/electron/src/main/network-proxy.ts`'s undici
> dispatcher) **and** `projectProxyEnv`, which writes the proxy into the host's own `process.env`
> where Bun's native fetch re-reads it per request. Fixing only the first leaves the second.
> **Decide the policy before the code:** auto-exempting loopback inside `shouldBypassProxy` overrides
> an administrator who wrote an explicit `noProxy` list that deliberately omits loopback — which is
> the opposite of the subprocess case, where the app owns the whole env.

Also worth a row note on **P2.261**: its trap reproduced exactly here, and the strongest cheap remedy
turns out to be a third one — never assign, build the child env as a plain object, and read the
variables back out of a throwaway child as a per-arm positive control.
