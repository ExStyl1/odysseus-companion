# PKG-4 — handing claude a skill as a DIRECTORY: what its native mechanism sees

**Row:** P3.297 · **Date:** 2026-09-03 · **Lane:** W2-p8
**Artefact:** packaged `NessyDesktop-1.33.0-mac-arm64`, runtime-switch fixture config dir
**Verdict:** PASS 9/9, 190 s — **MEASUREMENT ONLY.** The posture is the owner's
to decide; nothing here was built and nothing about skill delivery was changed.
**Case:** `scripts/cdp/cases/pkg-4.ts`

## The question

W2-j (P3.275) and P6.59 met the same wall from two sides: the host passes
`plugins: []` and renders skills into the prompt as text, and
`agent-sdk/skills.md` says skills are FILESYSTEM ARTIFACTS with no registration
API. The thin-host reading — hand claude the directories and stop rendering them
for that runtime — cannot be evaluated from source. Somebody had to put a
directory in front of the shipped binary and look.

Nothing had to change for the question to be asked:
`buildClaudeTurnShapeOptions` already passes
`settingSources: ['user', 'project', 'local']`, and a session whose working
directory contains `.claude/skills/<name>/SKILL.md` is therefore already handing
claude a skill directory.

## What was put in front of it

Two skills, in their own directories, inside the runtime-switch fixture project
(the one directory this harness may legitimately trust — see the rig note):

- `.claude/skills/pkg4-probe/SKILL.md` — plain, body returns `PKG4-SKILL-<nonce>`
- `.claude/skills/pkg4-fork/SKILL.md` — declares `context: fork`, body returns
  `PKG4-FORK-<nonce>`

**And the SDK's own project scope really was that directory.** The Claude SDK
files its transcripts under a slug of the session's working directory; today's
run wrote into
`claude-config/projects/-Users-i-i-gavrikov-nessy-cdp-rts-project/`, not under
the usual `…-config-sessions-<ws>-<sid>` slug. So this is not a case of the
skills sitting somewhere the SDK never looked.

## Result

| question | answer |
| --- | --- |
| did a native `Skill` tool call occur? | **no** — tools used were `Read` and `Bash` |
| did the model produce the skill body's token? | yes — by `Read`ing the SKILL.md after being told its name |
| does a no-tool enumeration name the skill? | **no** — it lists **32** skills, all host-rendered `[skill:…]` entries, and names neither `pkg4-probe` nor `pkg4-fork` |
| did `context: fork` dispatch? | **no** — zero `<forked-skill …>` blocks |

The enumeration is the load-bearing half, and it runs in a SECOND, FRESH session
whose first prompt is the enumeration — a first-run learning of this case, kept
verbatim in the file: asked in the same session, the model had already opened the
file with `Read` one turn earlier, so *"I was given the skill pkg4-probe"* would
be a memory of its own tool call rather than evidence that anything delivered it.
That turn used **no tools at all**, so whatever it names, it was HANDED. It names
32 host-rendered skills and neither of the two on disk beside it.

**`context: fork` is the cleanest signal, because both possible mechanisms leave
a distinct trace.** `base-agent.ts`'s `dispatchForkedSkillInvocations` writes a
literal `<forked-skill …>` block for every skill the HOST resolved with
`context: fork`, and says so in words when the backend cannot spawn a child
(`status="unavailable"`, *"Its instructions were deliberately NOT loaded"*). The
SDK's own path would instead leave a `Skill` tool call. **Neither appeared.** A
skill delivered only as a directory is never resolved by the host — the host
renders the skills it knows about — and nothing else picked it up.

## What this means for the row, stated without deciding it

On the shipped artefact, with the skill directory inside the SDK's own project
scope and `settingSources` naming `project`:

- the native `/skill`-style listing does **not** see it — the model's own
  enumeration is the host's rendered list and nothing else;
- `context: fork` does **not** dispatch for it;
- the only way the body reached the model was the model reading the file as a
  file, which any text file in the workspace affords and which is not a skill
  mechanism.

So the thin-host reading is not one setting away. Handing claude the directories
and dropping host rendering would, on this evidence, **remove the skill surface
rather than nativize it** — the host's rendering is currently the only thing
putting skills in front of that runtime.

**Not diagnosed here, and worth the owner knowing it is undiagnosed:** why the
`project` setting source did not surface a correctly-shaped `SKILL.md` in the
directory the SDK itself treated as the project. That is the question a decision
would turn on, and this run establishes the fact rather than its cause.

## Rig — the trust-gate deadlock, and why this case uses the fixture project

Binding a working directory the app does not trust raises a modal *"Trust this
project?"* gate, and `updateWorkingDirectory` **does not resolve until it is
answered** — while `trustFixtureProject` deliberately refuses to answer for any
path but the runtime-switch fixture project (*"Trusting any other directory is
the operator's decision"*). Every case in this tree writes
`await setWorkingDirectory(...)` and then `await trustFixtureProject(...)`, which
is an unreachable second line by construction; they get away with it only because
that project was already trusted from an earlier sitting.

PKG-6 measured all three faces of it in one sitting — a `Request timeout:
sessions:command (30000ms)` on a mutation that had landed, then
`session-project-mutation-busy` when the retry collided with its own
still-running call, and finally an evaluate that never answered at all — and with
a gate left open, `getSessions()` went from 802 ms to 5 163 ms and then past the
app's own budget, so `freshSession` reported `session-create-failed` about an app
that was merely blocked.

This case therefore does two things: it seeds its skills into the fixture project
rather than a `mkdtemp`, and its bind **starts the mutation without awaiting it**
and answers the gate beside it. That ordering is the actual fix and it belongs in
any case that needs a project.

The whole run was taken on the fixture config dir (98 sessions); the operator
profile's 743 sessions make `sessions:get` the harness's binding constraint — see
the PKG-6 narrative.

## How to re-run

```bash
NESSY_CONFIG_DIR=$HOME/nessy-cdp-rts/config \
  "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" --remote-debugging-port=9333
NESSY_CONFIG_DIR=$HOME/nessy-cdp-rts/config NESSY_CDP_PORT=9333 \
  bun scripts/cdp/cases/pkg-4.ts
```

The case writes its two SKILL.md files into the fixture project on every run and
leaves them there; they are named `pkg4-*` and are safe to delete.
