# PKG-7 — a real image carry, by evidence: reachable on Pi, unseen on Claude

**Row:** P3.57 · **Date:** 2026-09-03 · **Lane:** W2-p8
**Artefact:** packaged `NessyDesktop-1.33.0-mac-arm64`, runtime-switch fixture config dir
**Verdict:** PASS 12/12, 170 s, load 11–17
**Case:** `scripts/cdp/cases/pkg-7.ts`

## What the row asked for

P3.57's title is the assignment: *a real image carry is reachable on Pi and
blocked on Claude by **evidence**, not by types*. Both halves had been argued —
Pi's from an upstream type, Claude's from *"no vendor transcript observed carries
an image block"* — and "we have never seen one" is an ABSENCE claim, which
AGENTS.md says needs a positive control on the same rig. Nobody had run one.

## Register 1 — the SHIPPED artefacts (not the repo's `node_modules`)

P3.313 is why the distinction matters: the packaged app was shipping a different
SDK from the one the lockfile pinned, so every type read taken against
`node_modules/` described the dev tree. These come out of the `.app`.

| read | count | control |
| --- | --- | --- |
| `ImageContent` in `resources/pi-agent-server/index.js` | **19** | `TextContent` = 78; nonsense token = 0 |
| `type: "image"` across the shipped Claude SDK's 6 published `.d.ts` | **1** | `type: "text"` = 2; nonsense token = 0 |
| `image_error` (a `TerminalReason` value) | 1 | — |

**Pi: reachable, and the blocker is ours.** The shipped Pi runtime carries the
image content type nineteen times. Upstream types the message content as
`string | (TextContent | ImageContent)[]` (`@earendil-works/pi-ai`
`dist/types.d.ts`), while `packages/shared/src/agent/pi-session-rebuild.ts`
narrows `PiUserMessage.content` to `PiTextContent[]`. The narrowing is ours and
removable — now with the shipped artefact agreeing rather than only a type
declaration in the dev tree.

**Claude: the single published image shape is the Read tool's OUTPUT.** The one
`type: "image"` member the SDK publishes sits in `sdk-tools.d.ts`, inside
`FileReadOutput`, beside an `images?:` field the same file documents as *"Images
returned by inner Read calls — surfaced as image content blocks"*. There is **no
published transcript INPUT shape carrying an image**. So writing an image block
into a rebuilt Claude transcript asserts a shape the SDK's own type surface does
not describe — while the read-back path the shipped design already uses is the
one image shape it does.

`TerminalReason` including `image_error` is worth keeping beside that: the binary
can end a turn on an image problem, which is exactly the silent-rejection risk
the row names when it says the verifier cannot detect the SDK declining a
well-formed file.

## Register 2 — the corpus, with positive controls on the same files

| corpus | files | with an image block | control (`"type":"text"`) |
| --- | --- | --- | --- |
| Claude SDK transcripts (fixture profile) | 33 | **0** | 33/33 |
| Pi sidecars (fixture profile) | 95 | **0** | 95/95 |
| Claude SDK transcripts (operator profile, measured by hand) | 280 | **0** | 280/280, `tool_use` in 45 |
| Pi sidecars (operator profile, measured by hand) | 478 | **0** | 478/478 |

The row's premise holds and now has a control behind it. **And the same zero
holds for Pi** — so the asymmetry the row asserts is not "seen on Pi, unseen on
Claude". It is: on Pi the published type admits the block and our own type
removes it; on Claude no published type admits it anywhere. Neither has an
observed instance.

## Register 3 — the live half, REPORTED and not scored

A real 24×24 PNG was stored through the app's own `storeAttachment` and sent with
its `SessionAttachmentDto` ref, exactly as `App.tsx` does. The host recorded the
attachment on one user row in each arm. Both models answered *"I don't see any
image attached to your message"*, and no image marker appeared in either
runtime's own transcript.

**That is not scored, and the reason is the whole point of the row.**
`SessionManager.sendMessage` filters the outbound attachment array by
`modelSupportsImages`, so on a model that declares no image input the host never
sends one and the runtime never sees one. The gateway card's models are exactly
that case (P3.114's wall). Scoring the absence as "the runtime rejected the
format" would attribute a MODEL declaration to a RUNTIME capability — the same
conflation this row exists to remove. It is recorded with that explanation
attached.

## Register 4 — the carry itself, which WORKS

Switching the Pi session (holding a real attachment row) to `claude-gateway` and
sending one more turn: the rebuilt transcript claude received carries the shipped
pointer — `[Attached image: ` ×1, `[Stored at: ` ×1, and the handoff note *"did
not cross the runtime switch"* ×1 — and **no image block**. The model answered
from it.

That is P3.54's design behaving exactly as documented: the image becomes a NAMED
path the model can read back on demand, in position, rather than a fabricated
re-attachment. The one thing that must never happen — the attachment vanishing
with no trace — did not.

## What this leaves for the row

- **Pi's half is settled with artefact evidence**: the shipped runtime carries
  the type, our own narrowing is the blocker, and it is one type away.
- **Claude's half is settled the other way**: no published input shape, no
  observed instance in 313 transcripts across two profiles, and a named
  `image_error` terminal reason for getting it wrong. Shipping an image block
  into a rebuilt Claude transcript would still be asserting a format nobody has
  seen accepted — which is what the row said, now measured.
- **Unmeasurable here**: whether a runtime would ACCEPT an image block, because
  on this profile no model declares image input, so the host never offers one.
  That needs a card whose model declares `supportsImages`, and it is the one
  question this sitting could not reach.

## Rig notes

Two detector faults, both caught before they became findings:

- **The first run attached nothing.** A bare `attachments` array passed to
  `sendMessage` produced *"I don't see any image attached"* on both runtimes —
  indistinguishable from the product finding this row is about. `App.tsx` stores
  each attachment FIRST and sends the resulting refs alongside. The case now
  matches that path and **requires** the host to report at least one user row
  carrying an attachment before any conclusion is drawn from a transcript count;
  an arm that fails it reports UNMEASURED, never a negative.
- **`SESSION_BUSY` on the runtime switch** is transient and, unlike a
  mutation-boundary collision, has nothing in flight to wait for — re-issuing is
  the right response and waiting alone never succeeds. One arm was lost to it.

The whole run was taken on the runtime-switch fixture config dir; see the PKG-6
narrative for why the operator profile (743 sessions) could not be driven.
