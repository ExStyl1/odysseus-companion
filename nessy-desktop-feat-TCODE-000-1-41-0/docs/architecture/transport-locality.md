# Transport locality: which clients may do what

> **Scope.** This record is about the **calling client** — what the thing at the
> other end of the websocket is allowed to ask for. It is **not** about which
> server an RPC channel runs on. That is a different mechanism in a different
> file, and it uses the word "remote" to mean the opposite thing. Read
> "Two senses of 'remote'" at the bottom before carrying any conclusion from
> here into routing.

`packages/server-core/src/transport/capabilities.ts` referenced
`docs/adr-transport-locality.md` for years and that file was never in the
repository — found 2026-08-09 while implementing the remote permission ceiling.
This record is written from the code that exists, not from a lost original: it
states what is implemented today and why, so the next person to need it finds
something true rather than a dangling pointer.

## The question

The server is spoken to by more than one kind of client: the desktop renderer
running on the same machine, `apps/cli`, and — since the mobile pass — a phone
on the network. Some actions only make sense, or are only safe, when the caller
is running **on the machine the agent runs on**. "Reveal this file in Finder" is
meaningless from a phone. Turning off every approval prompt is meaningful, and
that is the problem.

## The decision

**Locality is read from the capability set the client advertises at handshake,
not from a flag it sets.**

`LOCAL_CLIENT_CAPABILITIES` is what a local Electron client announces:
`client:openExternal`, `client:openPath`, `client:showItemInFolder`,
`client:confirmDialog`, `client:openFileDialog`, `client:proposeMcpb`,
`client:browser:invoke`. Each is an action on the server's own machine.

`isLocalClient(server, clientId)` tests for `client:showItemInFolder`. That one
is the sharpest proxy available: revealing a file in Finder is an OS action on
the server's filesystem, so a client that can perform it is by definition local,
and a phone cannot advertise it honestly — it has no such Finder to reveal into.

Three properties of this shape are the reason for it:

- **No new wire field.** A `isLocal: true` flag on the handshake would be a
  claim the client makes about itself, which is worth exactly nothing against a
  hand-written websocket. A capability is a claim the client must then be able
  to *honour* when the server calls back into it.
- **Fail closed.** An unknown or empty capability set reads as REMOTE. That
  costs a desktop nothing (it always advertises) and it means a client we did
  not anticipate cannot inherit local privileges by accident. *This is a genuine
  fail-closed because REMOTE is the RESTRICTED end of this axis. Do not carry
  that reasoning into channel routing, where the same word marks the permissive
  end — see "Two senses of 'remote'" below.*
- **One place to change.** Adding a locality-gated action is one call, and the
  set of local capabilities is a single exported constant.

## What it currently gates

**Browser tools.** `RemoteBrowserPaneManager` needs a client that can drive a
local browser pane (`client:browser:invoke`); a phone-only session is refused
with `BROWSER_NO_CAPABLE_CLIENT`. The mobile app renders that refusal as "This
needs the desktop app to be connected to the same server."

**The permission-mode ceiling (F8, 2026-08-09).**
`REMOTE_CLIENT_PERMISSION_MODE_CEILING = 'auto'`, ranked against the existing
`PERMISSION_MODE_ORDER`. A remote caller asking for anything above it — in
practice `bypassPermissions` — is refused with `CAPABILITY_UNAVAILABLE` by
`sessions.ts` → `setPermissionMode`.

The reasoning is not distrust of the user. It is where the device is: a phone in
a pocket, on a network somebody else runs, must not be able to un-gate a
workstation. Both incumbents reached the same place — Claude's mobile app
refuses Bypass outright. `auto` stays reachable because it still asks about the
things that matter; `bypassPermissions` stops asking at all, and a phone that
cannot pick `plan` or `default` would not be safer, only useless.

**The mobile picker hides the mode as well, and that is cosmetic only.** The
enforcement is the server check. A hidden control is a suggestion, and the client
is the one component of this system an attacker can replace.

## What it deliberately does not gate

Reading and steering a session — messages, approvals, stop, model and permission
mode below the ceiling — is available to any authenticated client. Remote
control of a running agent is the mobile app's entire purpose; gating it by
locality would gate away the product.

## Consequences

- A future client type gets local privileges only by being able to perform local
  actions, which is the same bar the desktop meets.
- Raising or lowering the ceiling is one constant, and a test asserts it stays
  below `bypassPermissions` so it cannot drift to the top unnoticed.
- If a genuinely local client ever ships without `client:showItemInFolder`, it
  will be treated as remote. That is the safe direction, and the fix is to
  advertise the capability rather than to weaken the check.
- **`apps/cli` is exactly that client today, and it is harmless — for now.**
  Only the Electron preload handles `client:showItemInFolder`
  (`apps/electron/src/preload/bootstrap.ts`), so the CLI, which runs on the very
  machine the agent runs on, classifies as REMOTE. Verified 2026-08-09 that this
  gates nothing it does: the CLI sets `permissionMode` (including
  `bypassPermissions`) as a **session-creation option**, which this boundary does
  not touch, and the only session commands it issues are `setSources` and
  `setSessionStatus`. The trap is the future: the day someone adds mode-switching
  on a running session to the CLI, it will be refused with "cannot be set from a
  remote device" on the same machine. The fix then is for the CLI to advertise
  the capability (it can honour it — it has the filesystem), not to loosen
  `isLocalClient`.

## Two senses of "remote", and they point opposite ways

Added 2026-08-28 (P2.297). Two mechanisms in this codebase both sort things into
"local" and "remote". They are unrelated, they are in different packages, and
**the safety polarity of the word is inverted between them.** Neither document
mentioned the other until now, and that omission has a measured cost: two RPC
channels shipped unclassified (P2.282) into a routing table whose unknown case
crossed to another machine, and the sentence a reader would have consulted to
sanity-check that — this record's "Fail closed. An unknown or empty capability
set reads as REMOTE." — would have reassured them, wrongly.

| | **Client locality** (this document) | **Channel routing** (`packages/shared/src/protocol/routing.ts`) |
| --- | --- | --- |
| The question | *Who is calling?* | *Which server runs this call?* |
| Decided from | the capability set advertised at handshake (`isLocalClient`) | the channel name, classified in a static table |
| LOCAL means | the caller is on the agent's machine → **more** privilege | the call must stay on the local Electron server |
| REMOTE means | a phone, or any client that cannot honour local capabilities → **fewer** privileges | `REMOTE_ELIGIBLE`: the call **may leave this machine** → **more** reach |
| Unknown | reads as REMOTE, which is the **restricted** end. Genuinely fail-closed. | refused (`UnclassifiedChannelError`); before P2.296 it silently **crossed** |
| Enforced by | `sessions.ts` → `setPermissionMode`, `RemoteBrowserPaneManager` | `RoutedClient.routeFor` → `channelLocality()` |

So: **restricting a client is done by treating it as remote; permitting a
channel is done by marking it remote-eligible.** The word carries no consistent
direction on its own. Whenever you read "remote" in transport code, resolve
first whether the subject is a *caller* or a *channel*.

### Why the routing side is not simply renamed

It arguably should be. `RoutedClient`'s own two fields are already
`localClient` / `workspaceClient` — the runtime vocabulary is local/**workspace**,
and only the classification table says "remote". `channelLocality()` returns
`'local' | 'workspace' | 'unclassified'` for that reason, so the decision point
now speaks the unambiguous word even though the exported set is still called
`REMOTE_ELIGIBLE_CHANNELS`.

**Recommended follow-up:** rename the routing sense —
`REMOTE_ELIGIBLE_CHANNELS` → `WORKSPACE_OWNED_CHANNELS`, `isRemoteEligible` →
`isWorkspaceOwned` — and leave *this* document's sense alone. The routing term
is the newer and weaker of the two, the code it governs already uses
"workspace", and this record is where people arrive first when they search for
"local" and "transport". Not done in P2.296 because the exported name has a
consumer outside that change's zone
(`packages/server-core/src/sessions/__tests__/read-background-task-output.test.ts`).
