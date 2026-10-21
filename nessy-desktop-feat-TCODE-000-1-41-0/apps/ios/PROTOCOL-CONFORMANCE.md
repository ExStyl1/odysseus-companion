# M1 — protocol conformance: vendored client vs this fork's server

Measured 2026-08-09 against `apps/ios/` at vendor SHA `4fab98d1` and the desktop
tree at 1.22.0. The order below is the plan's, and it is not cosmetic: **channel
and method NAMES first, payload shapes second.** A renamed channel does not
error — it produces no events, and "no events" reads as "the feature is broken"
rather than "the client called the wrong name".

## 1. Channel names — 28 of 30 match exactly

Compared `RPCChannels.swift` against `packages/shared/src/protocol/channels.ts`
(303 channels ours, 30 theirs).

| verdict | channels |
| --- | --- |
| **match** (28) | every `sessions:*` the app uses — `create`, `get`, `getMessages`, `sendMessage`, `cancel`, `command`, `delete`, `getFiles`, `getNotes`, `setNotes`, `getPermissionModeState`, `getUnreadSummary`, `killShell`, `markAllRead`, `respondToCredential`, **`respondToPermission`**, `searchContent` · `session:event`, `session:getModel`, `session:setModel` · `server:getHealth`, `getStatus`, `getWorkspaces`, `createWorkspace` · `labels:create/delete/list` · `statuses:list` |
| **absent here** (2) | `skills:get`, `sources:get` |

The two absent ones are genuinely absent, not renamed — we have
`skills:delete/openEditor/openFinder` and `sources:create/delete/pendingAuth`,
but no `get`. Checked explicitly, because "renamed" and "missing" need different
fixes and look identical from the device.

**How the device should handle that is already in the protocol.** `handshake_ack`
carries `registeredChannels`, documented as *"Clients use this to avoid calling
unavailable channels"*. The Skills and Sources surfaces should be hidden from
that list rather than from a hardcoded one — which also answers M4's "hide
surfaces we do not serve" without a second decision.

## 2. Envelope — identical

`MessageType` matches 7 for 7: `handshake`, `handshake_ack`, `request`,
`response`, `event`, `error`, `sequence_ack`. The transport backbone needs no
adaptation.

## 3. Payload shapes — two breaking, five additive

The breaking ones are both **enums**, and the mechanism matters more than the
list. A Swift `String` raw-value `Codable` enum **throws** on a value it does not
know, and an Optional property does not rescue it: `decodeIfPresent` still throws
`DataCorrupted`. So one unrecognised string discards the **entire surrounding
payload**, silently.

Probed against the vendored code before fixing anything:

```
{"type":"outside_root"}
→ DecodingError.dataCorrupted: Cannot initialize PermissionRequestType
  from invalid String value outside_root
```

### 3.1 `PermissionRequestType` — BREAKING (fixed)

Ours has nine values, theirs had five. Missing: `workflow_launch`,
`worktree_approval`, `ask_user`, `outside_root`. Each would have discarded the
whole `PermissionRequest` — **no approval sheet at all**, which is the one thing
this app exists to show.

Fixed by adding the four cases *and* an `unknown` fallback with a custom
`init(from:)`. The fallback is not belt-and-braces: the desktop ships on its own
cadence, so the device will meet values this build has never heard of.

**And it did, sixteen days later — see §5.** Ours has TEN values now:
`worktree_setup` landed on 2026-08-25 (`22d71972b`). The fallback did its job,
so this was a degradation and not a break: `unknown` caught the value, and since
no screen switches on the type the sheet opened as usual. What was lost is the
value itself — a prompt whose type the client cannot name, in the one payload
where the type decides what the user is being asked to approve.

### 3.2 `PermissionMode` — BREAKING (fixed)

Theirs carried the **pre-migration** vocabulary (`safe`/`ask`/`allow-all`, three
modes). This fork moved to Claude's vocabulary on 2026-07-31 and has seven. The
server sends the canonical spellings, so the old enum would have failed to decode
`"explore"` — and M3's mode picker is exactly this payload.

Fixed by carrying our seven, keeping the legacy spellings as **read-only
aliases** (the desktop's own permanent rule: `safe → explore`, `ask → default`,
`allow-all → bypassPermissions`), and never emitting a legacy value back.

**F1.1069 (2026-09-29): six, and the picker follows the server.** The owner's
mode unification retired Nessy's own `explore`, so the enum is exactly Claude
Code's six and `explore` joined the read-only aliases (`explore → plan`,
`safe → plan`): an older server still reports it, and it reads as Plan. Every
wire field carrying a mode stays a raw `String`, and a value this build cannot
resolve is shown by its raw name and never offered. The picker renders from
`ComposerCapabilities.permissions` (now decoded), as the desktop's does: a
Nestor Cloud session offers only the cloud agent's own modes under its own
labels (Plan and Act); every other session offers Auto, Manual, Accept edits,
Plan and Bypass permissions in Claude Desktop's order, with Bypass permissions
listed but not offered (F8: the server refuses it from a remote device).
`dontAsk` is shown as "Don't ask" when a session holds it and is never offered.

### 3.3 `PermissionRequest` fields — additive, but two change behaviour

Every field theirs has, ours also has, so decoding never fails for lack of one.
Ours carries six more:

| field | verdict |
| --- | --- |
| `noAlwaysAllow` | **behavioural** — the sheet must hide always-allow; the server refuses to honour it. Ignoring it offers a button that does nothing |
| `parentSessionId` | **behavioural** — a prompt raised by a hidden child must surface in the visible ancestor. A client that ignores it attaches the prompt to a session the user cannot see, which reads as "no prompt arrived" |
| `agentLabel` | display only |
| `commandHash`, `approvalTtlSeconds` | server-side integrity/TTL; the device echoes nothing |
| `PiToolIdentity` (`semanticId`, `piName`, `surfaceVersion`, `originalName`, `manifestGeneration`, `manifestHash`, `manifestProvenance`) | additive; safe to ignore on device |

All six are now decoded. `noAlwaysAllow` is now also RENDERED (P6.727): the
approval sheet reads `PermissionRequest.canAlwaysAllow`, which withholds *Always
Allow* for `noAlwaysAllow == true` and for `worktree_cleanup` — the desktop's two
rules, in one Kit property so a `swift test` case can execute them. Routing on
`parentSessionId` remains M3's job; for that field this task still only
guarantees the data survives the wire.

## 4. The two measurements M1 owes

**(a) `maxPayload`.** Measured, not assumed: we set no explicit value in any of
the three `WebSocketServer` constructions in
`packages/server-core/src/transport/server.ts`, so `ws` 8.21.0's default applies.
Started a server and read it back: **104 857 600 bytes = 100 MiB** — exactly the
limit the vendored transport aligns to. No adaptation needed.

**(b) Does the desktop's embedded server admit external clients?** **Yes, when
Server Mode is on** — and the plan's premise ("no token gate in the sweep") is
wrong. `apps/electron/src/main/index.ts:642`:

- Server Mode **off** (default): binds `127.0.0.1` on an ephemeral port with a
  `randomUUID()` token — unreachable from another device, and the token is not
  stable enough to pair with anyway.
- Server Mode **on**: binds `0.0.0.0` on the configured port (default 9100) with
  the stable token from `ServerConfig`. The config's own comment says it plainly:
  *"binds to 0.0.0.0 on a fixed port instead of localhost on a random port,
  allowing thin clients to connect"*, with a *"Stable auth token for remote
  clients (auto-generated on first enable)"*.

So the phone can pair with the **desktop itself**, not only with a headless
`nessy-server`. That removes a whole moving part from the product story; M2 still
uses `nessy-server` because it is the contract `apps/cli` already proves, but the
desktop path is available and no longer an open question.

## 5. The check that was missing (added 2026-08-25)

Sixteen days after this document declared both enum gaps closed, one of them
reopened. `worktree_setup` was added to five TypeScript declarations plus the
runtime-snapshot validator and to none of the Swift mirror. Nothing failed.

`NessyWireDriftTests` existed and did not catch it, for **two independent
reasons**, and a fix for either alone would have left the other:

1. **It compares the wrong thing.** Its expected values are literals frozen in
   the test file on 2026-08-09 — `["workflow_launch", "worktree_approval",
   "ask_user", "outside_root"]`. It never reads the TypeScript that is the source
   of truth, so a value added there changes nothing it looks at. Those tests are
   worth keeping and were kept: they cover what a list comparison cannot, namely
   that an unknown value DEGRADES instead of discarding the payload around it.
   They were simply never a parity check.
2. **It would not have run.** `swift test` runs in CI under `build-ios`, whose
   rules are `changes: apps/ios/**/*`. `22d71972b` touched zero files under
   `apps/ios`. Even a perfect Swift-side guard would have stayed silent on the
   commit that caused the divergence.

So the check lives on the TypeScript side, reads both languages as text, needs
no Swift toolchain, and runs under `bun test` — which CI runs on every pipeline:
`scripts/ios-wire-enum-parity.ts`, with `…test.ts` as its CI reader.

It covers **8 Swift enums against 20 TypeScript declarations**:
`PermissionRequestType` (6 declarations), `PermissionMode` (3), `MessageType`
(2), `MessageRole`, `FileAttachment.Kind` (3), `RuntimeSwitchKind`,
`HistoryCarryPlan` (2), `ErrorCode` (2). Three properties, in the order the
failures matter:

- **Completeness.** Every WIRE-VOCABULARY enum in the iOS client is either
  registered as mirroring a TypeScript list or exempted with a written reason.
  This is what makes it a guard rather than a fix for one enum: the NEXT mirrored
  enum cannot be added with nothing watching it. `CodingKeys` is exempt by its
  `CodingKey` conformance — a compiler-visible signal, not a hand-kept list.
- **The TypeScript copies agree with each other**, checked before Swift is even
  read. A fork between two TypeScript copies is the same defect one layer
  earlier, and this repo keeps six copies of one list.
- **Swift matches**, on raw values as sets. Swift-only sentinels (`unknown`) are
  declared per entry, so a sentinel cannot be mistaken for drift and drift cannot
  hide behind a sentinel — a sentinel that becomes a real wire value is its own
  reported finding.

An anchor that stops resolving is a **finding, never a skip**: a declaration that
moved or was renamed is precisely the `Task`→`Agent` shape, so it must be
re-pointed deliberately rather than quietly dropped.

**Verified by re-breaking it**, five ways, each restored afterwards: removing the
`worktree_setup` case again (names the missing value); adding a case to a
*different* enum in TypeScript only (fails both the copies check and the Swift
check); adding a new unregistered Swift string enum; renaming a mirrored
TypeScript declaration; and forking two TypeScript copies with Swift untouched.

## 5a. What "every enum" meant, and did not (added 2026-09-04, P3.358)

Nine days after §5 declared the completeness clause the thing that made this a
guard, an enum it could not see turned out to be **eight codes behind**.

`ErrorCode` — the code on every refused RPC — was outside the check **by
construction**, and no amount of care about the registry would have found it.
Discovery required a `String` raw-value conformance. `ErrorCode` has a case that
carries an associated value (`case unknown(String)`, the forward-compat
sentinel), and Swift forbids a raw value on such an enum. So the clause that was
supposed to say "a mirrored enum cannot go unregistered" was structurally unable
to see this one, and its green verdict said so every time.

That shape is not incidental. An enum the compiler cannot give raw values to is
exactly the one whose vocabulary is written **twice by hand** — a decode table
and an encode switch — so it is both the least watched and the most able to
drift. Nothing checked those two halves against each other either.

What changed:

- Discovery accepts a second spelling. The signal for it is `case
  unknown(String)`: the same kind of in-source marker as the `CodingKey`
  conformance, and it says "this decodes a string off the wire and degrades
  rather than throwing". It finds exactly two enums — `ErrorCode`, now mirrored,
  and `SessionEvent`, now exempt (a **deliberate subset**; its own header says
  so, and registering it would leave the guard permanently red for events the
  phone is meant not to model, which is how a guard gets muted).
- The two hand-written Swift halves are read by name and compared **with each
  other** before either meets TypeScript — the same defect as the TypeScript
  copies check, one language over.
- An anchor that resolves and then scans **zero** members is now its own finding
  (`anchor-scanned-nothing`). It was not, and the `Kind` mirror had been red
  since `a07b1e8a1` moved the attachment vocabulary into `file-types.ts`:
  two anchors still matched, both scanned nothing, and the result was reported
  as *drift* with one side blank. Both re-pointed at the one declaration that
  replaced them.

**Known residue, stated rather than implied.** An associated-value enum that
mirrors a wire list and carries no `unknown(String)` case is still not
discovered. Such an enum throws on a value it does not know instead of
degrading, so it fails loudly on the device the first time the server sends one
— a different failure from the silent one this file exists to catch.

**Re-broken five ways, dead control first**, each restored by writing the whole
pre-mutation file back and asserting the hash returned to baseline: a comment
that changes nothing (**green**, so the four reds below are attributable); a
value removed from the decode table (`swift-halves-disagree` **and**
`swift-mismatch`); the same value removed from the encode switch **only**
(`swift-halves-disagree` alone — **the mutant nothing that existed before could
see**); `ErrorCode` dropped from the registry (`unaccounted-enum`, which before
this produced nothing at all); the `Kind` anchor pointed back at the emptied
declaration (`anchor-scanned-nothing`).

**One deliberate gap, recorded rather than hidden.** `AgentRuntime` is exempt
because it restates a FUNCTION, not a list — `providerTypeToAgentProvider`, as a
switch with a `default` arm that resolves anything unheard-of to `pi`. A runtime
added to the factory will show on the phone as "Pi" until someone extends the
switch, and no list comparison can see that, because there is no list. Closing it
needs a providerType catalogue on the wire: a protocol decision, not a test.

## Verdict for the gate

Nothing downstream is blocked. Two breaking items existed, both were codec-side
exactly as the plan predicted, both are fixed and covered by
`NessyWireDriftTests` (6 cases). Kit: **60 tests, 0 failures**. App: BUILD
SUCCEEDED for the simulator.

**Amended 2026-08-25 (§5).** "Covered by `NessyWireDriftTests`" was the wrong
word: those tests pin BEHAVIOUR, not parity, and one of the two enums drifted
again without them noticing. Re-measured on the same rig after adding
`worktree_setup` and the parity check: Kit **106 tests, 1 skipped, 0 failures**;
app **52 tests, 0 failures**, TEST SUCCEEDED on iPhone/iPad simulator
(iOS 26.3.1, Xcode/Swift 6.2.3).
