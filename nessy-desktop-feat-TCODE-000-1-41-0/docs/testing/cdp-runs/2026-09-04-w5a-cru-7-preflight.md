# CRU-7 — the WebFetch domain preflight, read out of the binary (2026-09-04, lane W5-a)

**Verdict: the case landed, the OFFLINE half is measured and pinned, the LIVE
half is owed and needs a packaged build behind a proxy.**

## What changed about the question

The checklist row and `claude-agent.ts` both said the egress *"cannot be proven
from this tree"*, on the grounds that the logic lives in the native binary the
staging script fetches rather than in the vendored `sdk.mjs`. That was an
UNREAD claim rather than an unprovable one: `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
is vendored, it is greppable, and at `claudeCodeVersion 2.1.233` it states every
load-bearing fact itself. The 1.18.0 release note was corrected on the
documentation's word alone while the artefact was on disk.

## Measured, verbatim, 2026-09-04 (`git status`: my zone files modified by me,
## nine other lanes' files modified by them; the binary is unmodified vendored
## `node_modules`)

```js
class W9o{urls=new DD({maxSize:zgb,ttl:kVs()});domainChecks=new DD({max:128,ttl:300000});…}

async function J4d(e,t){
  if(t.domainChecks.has(e))return{status:"allowed"};
  try{let r=await ri.get(`https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(e)}`,{timeout:Ygb});
    if(r.status===200){if(r.data.can_fetch===!0)return t.domainChecks.set(e,!0),{status:"allowed"};return{status:"blocked"}}
    return{status:"check_failed",error:Error(`Domain check returned status ${r.status}`)}}
  catch(r){return w(`Domain blocklist check failed for …`)}}

// call site
if(!ka().skipWebFetchPreflight)switch((await J4d(b,n)).status){
  case"allowed":break;case"blocked":throw new ora(b);case"check_failed":throw new ira(b)}

// the setting
skipWebFetchPreflight:qt().optional().describe(
  "Skip the WebFetch blocklist check for enterprise environments with restrictive security policies")

// timeouts
Ggb=2000,Vgb=10485760,Kgb=60000,Ygb=1e4
```

Counts on the same rig, with controls: `domain_info` → 2, `skipWebFetchPreflight`
→ 7, and a fabricated endpoint spelling → 0.

### The four consequences, each of which changes what a fix or a probe can be

1. **The endpoint is a hardcoded absolute URL and the hostname is a QUERY
   PARAMETER.** The per-session loopback adapter cannot intercept it,
   `ANTHROPIC_BASE_URL` does not move it, and it is not a header anything could
   strip. Any mitigation has to be the setting or the network.
2. **The only gate is `skipWebFetchPreflight`** — a settings key, not an env var.
   That is why `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which this fork does
   force on the gateway path, cannot reach it, exactly as
   `data-usage.md#webfetch-domain-safety-check` says.
3. **The cache is allow-only, 128 entries, five minutes.** This is the fact that
   invalidates the obvious probe: a second run against the same hostname is
   answered from memory, the proxy log stays empty, and that reads exactly like a
   fix.
4. **The setting's describe names enterprise environments**, which is the audience
   the owner decision is about.

## What the case drives, and the three detectors it refuses

`scripts/cdp/cases/cru-7.ts`. The live half shrinks to two questions a static
read cannot answer: does the preflight execute in a PACKAGED gateway session, and
is `WebFetch` in that session's tool set at all.

- **A reused hostname produces no egress** (fact 3). The case mints a fresh label
  per run and asserts the proxy log does not already contain it, so a truncated
  stamp cannot silently reuse one.
- **The model's reply is not the instrument.** "I could not fetch that" is equally
  true of a blocked preflight, a DNS failure, a denied tool and a model that
  declined. The verdict is read from `NESSY_CDP_PROXY_LOG`.
- **An absence needs a positive control on the same rig.** The WebFetch GET for
  the probe URL must appear in the same log window; without it, "no
  api.anthropic.com line" cannot be told from "the proxy saw nothing at all".

`NESSY_CDP_PROXY_BLOCKS_ANTHROPIC=1` selects the cheap discriminator: with the
endpoint refused at the proxy, `check_failed` makes the binary THROW, so a fresh
hostname must FAIL while a cached one still succeeds — a pair a healthy network
cannot produce.

## Owner decision, unchanged by this run and now with three options

Not decided here. (A) leave it — every WebFetch hostname, an internal one
included, reaches Anthropic, and a network that blocks `api.anthropic.com` fails
the fetch outright rather than degrading. (B) set `skipWebFetchPreflight` through
`Options.settings` — the egress stops and so does the blocklist, so the model may
fetch anything. (C) set it AND pair it with a host-supplied domain allowlist,
which is what the page itself prescribes and which is native-first: the runtime
already ships `WebFetch(domain:…)` permission rules and
`sandbox.network.allowedDomains`, and this repo already parses both. Pi and codex
run no such preflight on any path, so whichever is chosen the residual difference
owes one disclosure row.
