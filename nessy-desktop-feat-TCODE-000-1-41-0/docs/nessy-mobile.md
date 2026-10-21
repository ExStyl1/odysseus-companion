# Nessy Mobile — the iOS/iPadOS remote

A phone client for an agent that runs somewhere else. It browses sessions, reads
streaming turns, and — the reason it exists — **answers permission approvals**
while the agent keeps working on the desktop. There is no agent runtime on the
device: it is a thin client to the same WebSocket RPC server the desktop
renderer and `apps/cli` already speak.

Source lives in `apps/ios/` as `NessyAgentKit` (protocol, transport, models) and
`NessyMobile` (the app). It began as a vendored upstream pull request at a pinned
SHA; the owner decided on 2026-08-09 to **fork and own it**, so upstream is no
longer tracked and the modules carry Nessy names. Provenance, license and every
deviation — under the names the files had when each was made — are in
`apps/ios/UPSTREAM.md`; the wire comparison is in
`apps/ios/PROTOCOL-CONFORMANCE.md`.

## What works today

Measured on an iPhone 17 Pro simulator against a real `nessy-server`, not a mock:

| | |
| --- | --- |
| Pairing | server URL + token, stored in the device Keychain |
| Browsing | workspaces, session list, session history |
| Live turns | streamed text arrives as it is generated |
| **Approvals** | a pending permission renders with the command verbatim; answering **unblocks the waiting turn** |
| Control | stop an in-flight turn; switch permission mode; switch model |
| Offline | the cached session list stays readable behind an explicit banner; sending and approvals are disabled |
| Reconnect | returning from the background reconnects on its own |
| Two devices | an iPad alongside the iPhone — the second client does not evict the first |
| iPad | split view: sidebar plus detail pane |
| Errors | every failure is a localized sentence with the wire code in small print — never a raw type |

Permission modes on the device are this fork's seven, not upstream's three, and
the pre-migration spellings still decode.

The interface is Russian and English; the app is named Nessy and carries the
desktop product mark.

## Running it

The app needs a server it can reach and a token. Two servers can serve it, and
the difference matters:

**Headless `nessy-server`** — the contract `apps/cli` already uses.

```bash
NESSY_SERVER_TOKEN=<secret> NESSY_RPC_HOST=127.0.0.1 NESSY_RPC_PORT=9101 \
  bun run packages/server/src/index.ts
```

**It will not serve a phone on that host.** `127.0.0.1` is reachable only from
the Mac itself, and pointing it at a network address is *refused*, by design:

    ❌  Refusing to bind to a network address without TLS.
       Authentication tokens would be sent in cleartext.

The server logs that, calls `stop()` and exits — one millisecond after it
reports "listening", which reads exactly like a crash if you skim the log. Two
ways forward, and the first is the one to prefer:

```bash
# 1. TLS — the intended path
NESSY_RPC_TLS_CERT=<cert> NESSY_RPC_TLS_KEY=<key> \
NESSY_SERVER_TOKEN=<secret> NESSY_RPC_HOST=0.0.0.0 NESSY_RPC_PORT=9101 \
  bun run packages/server/src/index.ts
```

```bash
# 2. Explicit override — plaintext on the wire, for a trusted network only
NESSY_SERVER_TOKEN=<secret> NESSY_RPC_HOST=0.0.0.0 NESSY_RPC_PORT=9101 \
  bun run packages/server/src/index.ts --allow-insecure-bind
```

**The desktop app's embedded server** — available when Server Mode is on. It
then binds `0.0.0.0` on the configured port (9100 by default) with a stable
token generated on first enable. With Server Mode off it binds loopback on a
random port with a per-run token, which is unreachable from another device
rather than merely unprotected.

Pair with the scheme included — `ws://host:port`. A bare `host:port` is
normalised to `wss://`, and pointing that at a plain-ws server fails with an
opaque TLS error rather than a useful one.

## Reachability: LAN now, and the options after it

The device currently reaches the server over the local network. That is a
deliberate stopping point, not an oversight: it is enough for the product to be
useful at a desk, and it commits nothing. Four ways to go further, with what each
actually costs.

### 1. LAN only (today)

Phone and server on the same network; the token is the whole of the auth story.

- **For:** nothing to build, nothing new to secure, no third party in the path.
- **Against:** useless away from the network — which is precisely the "approve
  it from the sofa, or from the office car park" case the app was built for.
- **Honest risk:** plain `ws` on a shared network means the token and the whole
  session transcript cross it in clear text. On a home or office LAN that is a
  real exposure, not a theoretical one. TLS on the embedded server closes it
  (`ServerConfig` already has cert/key fields).

### 2. User-run tunnel (Tailscale, WireGuard, SSH forward)

The user brings their own overlay network; the app keeps thinking it is on a LAN.

- **For:** no code at all. Encryption, identity and NAT traversal are the
  tunnel's problem, and those tools do it better than we would.
- **Against:** every user has to set it up, and a corporate device may not be
  allowed to. Support burden lands on us anyway when it misbehaves.
- **Verdict:** the cheapest honest answer for the next milestone, and worth
  documenting as the recommended path before building anything.

### 3. The remote-workspace path (`connectRemoteWorkspace` / A2A)

We already have a remote-workspace mechanism for desktop-to-desktop. Point the
phone at it instead of at a local server.

- **For:** reuses a path that exists and is already reasoned about, including
  its auth. The phone stops being a special case.
- **Against:** it was designed for a desktop peer, not a battery-powered client
  that sleeps mid-turn. Reconnection, event replay and background lifecycle all
  need answering — and the event-replay behaviour has already bitten this app
  once (it is what left a stop button on an idle session). The M1 table's
  channel work would need redoing for whatever subset the remote path exposes.
- **Verdict:** the most likely long-term answer, but it is a milestone, not a
  switch.

### 4. A relay we host

A rendezvous service both sides connect out to, so neither needs an inbound port.

- **For:** works everywhere, including cellular and hostile NAT. The best user
  experience by a distance.
- **Against:** we would be operating a service that sees every session's traffic
  unless it is end-to-end encrypted, and end-to-end encryption between a desktop
  and a phone means key management on a personal device — which the owner has
  already ruled out for credentials (device auth is pairing-token-only, no
  dp/JWT on the phone). It also becomes an availability dependency for a feature
  that currently has none.
- **Verdict:** do not build this without a decision that we are prepared to run
  it.

**Recommendation.** Keep LAN, document the tunnel as the supported way to leave
the network, and put TLS on the embedded server before anything else — it is the
smallest change that removes a real exposure and it is a precondition for every
option above. **The product already agrees**: `nessy-server` refuses a
plain-`ws` network bind outright, and `--allow-insecure-bind` exists precisely
so that refusal is a deliberate choice rather than an accident. Treat the remote-workspace path as the next milestone's question,
with reconnection and background lifecycle as its actual content.

## Known gaps

- **Skills and Sources: screens planned, server channels planned.** Only
  `NessyAgentKit` carries those models today; `skills:get` and `sources:get` do
  not exist on this server, and no screen calls them. **A separate server-core
  unit will add the channels** (owner, 2026-08-09), and the app is already built
  to meet it: gating is capability-driven off
  `handshake_ack.registeredChannels` via `RPCTransport.supportsChannel(_:)`, so
  a surface appears the day its channel is served — **no app change required**.
  Unknown reads as supported, never as "supports nothing", so an older server
  cannot black out the UI. (An earlier revision of this page said the screens
  existed. They do not.)
- **Browser tools are refused** for a phone-only session — they need a connected
  desktop client. Hiding these is correct by nature at the point of refusal:
  `BROWSER_NO_CAPABLE_CLIENT` and its siblings now render as "This needs the
  desktop app to be connected to the same server." rather than as a raw error.
- **The Flagged filter chip is clipped in Russian.** The row scrolls, so the
  chip is reachable, but the label is cut at the edge on a 402-point screen.
- **Server-sent strings stay English** (`Invalid token` and friends). They are
  the server's vocabulary, not the app's, and localising them means a code on
  the wire the client can map — worth doing when the list of them settles.
- **No TLS on the phone path yet.** `nessy-server` refuses a plain-`ws` network
  bind for exactly this reason, and every measurement here used
  `--allow-insecure-bind` on a trusted network. Certificates first, then this
  gap closes on its own.
