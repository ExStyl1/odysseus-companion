# W2 — P2.324 (detector) and P2.323 (measurement) — report

**STATUS: BOTH ROWS LANDED.** P2.324 is a durable enforcement detector, proven by two
independent re-breaks. P2.323 is a measurement and a write-up; **no production code was
changed**, and the shape decision is left to the owner as instructed.

- Baseline SHA recorded **before** any work: `05733c4ad7c8f4b68dfbdf8e89c44191a9ea7ca2`
- `2aa003420` — `test(codex): assert the credentials.enc deny against the sandbox, not the TOML`
- `185172b05` — `docs(codex): measure what "sandbox off" leaves in force, and cost the options`
- HEAD at report time: `185172b05749b6f31e7902d9949e098f4f5562b9`

Both commits made by explicit pathspec; `git show --stat` on each shows exactly one file,
both new, neither touched by any other lane.

---

## 1. P2.324 — the detector

`packages/codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts` (new, 417 lines).

### What it asserts — enforcement, never configuration

Seven tests. Both oracles the previous lane identified, both already in-tree, no gateway auth,
no model spend:

**Oracle 1 — `command/exec`** ("Run a standalone command … in the server sandbox without
creating a thread or turn … defaults to the user's configured policy when omitted",
`packages/codex-protocol/generated/v2/CommandExecParams.ts`). Four spawns, each an isolated
`CODEX_HOME`, each config the **verbatim output of `buildCodexConfigToml`** driven the way
`CodexAgent` drives it — `mode` + `sandboxGloballyEnabled` + `deniedReadPaths`, never a
hand-written `sandbox_mode`. Driving the real derivation chain is deliberate: a detector that
hardcoded the emitted keys would not notice the mapping changing underneath it.

| Case | Expectation |
| --- | --- |
| control — no `deniedReadPaths`, so no profile emitted at all | decoy **readable** |
| control — profile present, denies an **unrelated** path | decoy **readable** |
| **shipped default** (master switch OFF → `danger-full-access`) | profile **accepted** + decoy **refused** |
| master switch ON (`workspace-write`) | profile **accepted** + decoy **refused** |

**Oracle 2 — a real agent turn.** `startStubAdapter` as the Responses upstream, canned to call
codex's native `exec_command` with `cat <decoy>`; the assertion reads the wire the model
actually sees — the `function_call_output` on the **second** Responses request. Two spawns: the
shipped default (secret must not appear) and its no-profile control (secret must appear).

### Why a green here means something

Three design choices, each answering a specific way this could have shipped as a false green:

1. **Every enforcement case is paired with a control in the same run.** A rig that refused
   everything — wrong fixture path, binary that won't exec, sandbox unavailable on the host —
   would pass a bare "the read was refused" file while proving nothing. The `no profile` control
   proves the rig can read and that reads outside the workspace are otherwise allowed; the
   `denies an unrelated path` control proves the refusal is **our deny line** rather than the
   `:workspace` parent blocking every outside read.
2. **Fixtures live under `~/.cache`, never `tmpdir()`.** `workspace-write` treats `/tmp` and
   `TMPDIR` as writable by default (`exclude_slash_tmp`), which is what invalidated P2.306's
   round 1. Documented in the file so it is not "cleaned up" later.
3. **Approval escalation is refused, not accepted.** Every server→client request is answered
   `denied`, because an accepted escalation can rerun a command unsandboxed and would confound
   the reading in either direction.

### Skip behaviour — a named skip, never silence

The codex binary is a build-time download and is gitignored (`apps/electron/.gitignore`:
`resources/bin/codex/`), so CI's Linux container has none and the enforcement blocks skip there.
Rather than let that read as a pass, an always-running test prints
`[sandbox-detector] SKIPPED: … Enforcement of the credentials.enc deny was NOT verified in this
run`, and `NESSY_CODEX_SANDBOX_DETECTOR=required` turns the skip into a **failure** — the switch
to flip on any runner that does stage the binary.

### PROOF IT DETECTS — two re-breaks, against the recorded baseline

Both re-breaks run **the committed assertions verbatim**, from a copy outside the repo, so no
repo file was mutated and no other lane could pick up a broken working tree.

**Re-break 1 — the pin starts implementing the documented precedence.** The producer is wrapped
to strip `default_permissions` and the whole `[permissions.*]` block, leaving `sandbox_mode` —
byte-equivalent to a binary that honours the page.

```
 4 pass
 3 fail
Ran 7 tests across 1 file. [31.88s]
(fail) … SHIPPED DEFAULT (sandbox master switch OFF): the decoy read is REFUSED [806.30ms]
(fail) … sandbox master switch ON: the decoy read is REFUSED [238.00ms]
(fail) … SHIPPED DEFAULT: the secret never reaches the model [651.53ms]
   Expected to not contain: "NESSY-SANDBOX-DETECTOR-SECRET-4c1e"
   Received: "NESSY-SANDBOX-DETECTOR-SECRET-4c1e\n"
```

Exactly the three enforcement assertions fell; all four controls stayed green. Failures at
0.2–0.8 s — well under the 3.3 s line that separates real failures from load artefacts.

**Re-break 2 — the fail-open.** `extends` rewritten to `:danger-full-access`, which this pin
rejects.

```
 4 pass
 3 fail
Ran 7 tests across 1 file. [23.77s]
(fail) … the profile is ACCEPTED and the decoy read is REFUSED   Expected: true  Received: false
```

The `profileAccepted` guard fires **before** the read assertion, which is the useful ordering:
the message says "the binary rejected our profile", not "the secret leaked".

### Cost, stated because it lands in the ordinary suite

Six codex spawns. The file alone measured 19.5 s / 28.6 s on two runs; the whole package went
from 13 files to 14 and ran in 11.7 s and 19.9 s on two runs. Several lanes were live
throughout, so treat these as a range, not a number — timing is not part of any claim here.

---

## 2. P2.323 — the measurement (NO code change)

Written up in `docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md`. Summary:

### Premises, all confirmed before measuring

- `resolveRuntimePolicy` (`config-writer.ts:808`) —
  `permissionParent: sandboxMode === 'read-only' ? ':read-only' : ':workspace'`. So
  `danger-full-access` lands on `:workspace`. **Confirmed by reading.**
- `deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')]` is an unconditional literal at all
  three `CodexAgent` call sites (`:1254`, `:1400`, `:2386`), so `hasFilesystemPolicy` is always
  true and the profile **always** ships. **Confirmed by reading.**
- `SANDBOX_ENABLED_DEFAULT = false` (`packages/shared/src/config/sandbox-settings.ts:353`), so
  the switch-OFF arm **is** the shipped default. **Confirmed by reading.**

### What "sandbox off" actually leaves in force

Three arms over `command/exec`, macOS arm64, `rust-v0.148.0`. `off_true` (no deny passed → no
profile emitted) is the control for every row.

| Capability | **OFF + deny (SHIPPED DEFAULT)** | OFF, no profile (control) | ON + deny |
| --- | --- | --- | --- |
| read inside workspace | ok | ok | ok |
| write inside workspace | ok, landed | ok, landed | ok, landed |
| read ordinary file outside workspace | ok | ok | ok |
| **write outside workspace** | **refused** | ok, landed | refused |
| **read the denied `credentials.enc`** | **refused** | **secret read** | refused |
| **network — loopback HTTP** | **refused, `curl: (7)`** | `200` | refused |
| **network — `https://1.1.1.1/`, no DNS** | **refused, `curl: (7)`** | `301` | refused |
| DNS (`dscacheutil -q host`) | **exit 0, empty output** | resolves | exit 0, empty |
| `ls $HOME` | ok | ok | ok |

**The shipped "off" column and the "on" column are identical on every row.** The master switch
changes nothing observable on the codex runtime.

**The headline is not writes — it is the network.** The agent's shell has no network at all in
any configuration this product ships: `npm install`, `git fetch`, `curl`, every package manager.
And DNS is worse than blocked — `dscacheutil` exits **0** with empty output, so the failure
presents as "no such host" rather than "denied". This was listed as unmeasured by the previous
lane; it is now measured, with a control that discriminates in both directions.

The copy on that same switch says, verbatim (`settings.permissions.isolationDisabled`):
*"Isolation is turned off (sandbox.enabled), so none of the profiles below are applied."* On the
codex runtime that is false. (Whether that exact string renders while a codex connection is
selected is a renderer question I did **not** check.)

### The option space, costed against measurement — presented, not chosen

`permissionProfile/list` reports three built-ins, `:read-only` / `:workspace` /
`:danger-full-access`, all `allowed: true`. **That list is not a list of usable parents:**

| `extends` | profile `allowed` | credential read | write outside ws | loopback |
| --- | --- | --- | --- | --- |
| `:workspace` (shipped) | `true` | refused | refused | refused |
| `:danger-full-access` | **`false`** | **secret read** | refused | refused |
| `:no-such-parent` (negative control) | `false` | secret read | refused | refused |

Binary stderr, verbatim, on both rejected arms:
`Invalid configuration; using defaults. permissions profile `nessy_runtime` cannot extend
unsupported built-in profile `:danger-full-access``

- **Option A — the affordance stops claiming to disable the sandbox.** Copy and docs only, no
  runtime risk. What must then be accepted as permanent: no network from the agent's shell in
  any shipped configuration, plus the DNS failure mode that reports success.
- **Option B — `danger-full-access` really means full access.** Stop emitting the profile when
  the switch is off. Cost **measured, not guessed**: the credential deny goes with it — the
  control arm read the decoy secret. Re-parenting to keep the deny is impossible on this pin,
  per the table above.
- **Option C — widen the profile rather than replace its parent.** `PermissionProfileToml` in
  `packages/codex-protocol/schema/config-schema.json` carries `network` and `workspace_roots`
  alongside `filesystem`, so the shape that keeps the deny *and* lifts the confinement plausibly
  exists. **Not measured.** It is the only option that could satisfy both goals, and costing it
  needs a spike.

I stopped at establishing feasibility. No fix was designed and no production file was touched.

---

## 3. Findings — each tagged, with its kind

### N1 — `[doc:codex]` · kind: **bug** — a rejected permission profile fails OPEN, silently

**This is new; it fell out of the P2.323 feasibility probe and is not in P2.306's report.**

An `extends` the binary rejects — an unsupported built-in, a typo, or schema drift on a future
pin — produces **no RPC error**. It writes `Invalid configuration; using defaults` to **stderr
only** and discards the entire `config.toml`. The credential deny disappears. Codex's own
default `workspace-write` then keeps refusing outside writes and network, so from every angle
except the credential read the session still *looks* sandboxed — the one observable that changes
is the one nobody watches.

Two consequences worth separating:

- In **tests**, this is now caught: each enforcement case asserts `permissionProfile/list`
  reports `nessy_runtime` with `allowed: true` before it asserts the read.
- In the **runtime**, nothing consults that signal. `CodexAgent` does not read
  `permissionProfile/list`, and the app-server's complaint is on stderr. Whether the runtime
  should refuse to proceed on `allowed: false` is a separate decision, outside P2.324's scope
  and outside my zone (`packages/shared/src/agent/codex-agent.ts`). **Recommend a row.**

Documentation: `permissions.md` describes profile syntax but not this failure mode; the
rejection message is a binary string, not a documented contract. Tagged `[doc:codex]` because
the profile system is codex's contract, but note the page does not cover it.

### N2 — `[doc:none]` · kind: **bug** — "sandbox off" is behaviourally identical to "sandbox on"

P2.323 as written, confirmed and then widened: the row anticipated the write confinement; the
**network blackout** and the **silent-success DNS failure** were not known. Owner decision
pending; see §2. No upstream page decides what our master switch should mean — this is our
affordance and our copy, so `[doc:none]` explicitly rather than by omission.

### N3 — `[doc:codex]` · kind: **never looked at** — the control survives on undocumented Beta behaviour

Restated from P2.306 F3 because it is the row I landed, not a new claim. The page says
`sandbox_mode` wins; the binary lets the profile win. Now alarmed. The alarm is pinned to
**`rust-v0.148.0` on macOS arm64** — see §4.

### N4 — `[doc:none]` · kind: **never looked at** — `packages/codex-responses-adapter` is outside the lint graph

**Independently re-verified, not inherited.** No `eslint.config.*` or `.eslintrc*` in the
package; root `lint` is exactly `lint:electron && lint:shared && lint:server-core && lint:ui &&
lint:scripts`. Positive control: `packages/shared/eslint.config.mjs` exists. This is why the
eslint gate below is **NOT-RUN** rather than green — there is nothing to run. A package holding
the security-path config writer and now 14 test files is never linted.

> **SUPERSEDED 2026-08-28 (P3.185) — true when measured, false now, and a stale exclusion note is
> read as permission to skip a gate, so this one gets a correction rather than a footnote.**
> `9f4f15d31` (P2.319) added `packages/codex-responses-adapter/eslint.config.mjs` and the root
> script `lint:codex-responses-adapter`; root `lint` chains **seventeen** scripts today, not five.
> Re-measured: `cd packages/codex-responses-adapter && npx eslint .` exits **0**, no output. The
> gate is runnable and green — `NOT-RUN` is no longer the honest verdict for this package.

### N5 — `[doc:none]` · kind: **never looked at** — the UI copy for the master switch is measurably wrong on codex

`settings.permissions.isolationDisabled` says none of the profiles are applied; on codex a
`:workspace` profile is applied. Two neighbouring strings look wrong in the same direction and
I did **not** verify whether either renders on the codex path:
`settings.permissions.isolationSectionDesc` ("Every profile grants whole-filesystem read and
scopes only writes" — the codex profile also closes the network and denies one read) and
`settings.permissions.isolationEgressOpenDesc` ("A sandboxed command can reach any host" —
measured false in every shipped codex arm). Renderer files are outside my zone; **recommend a
row** rather than reaching across.

### Scope verdict I am recording rather than staying silent about

`docs/README.md` indexes a **curated** set of specs (the parity trio, the coverage map, the
generated sweep reports), not every file under `superpowers/specs/`. I did not add a line for
the new spec: it is a one-off measurement, not an index-level artefact, and that file is likely
hot across lanes. Stated as a verdict so it does not read as an omission.

---

## 4. What I did NOT measure

Carrying the previous lane's caveats forward, plus mine:

- **macOS arm64 only** (Seatbelt). Linux (Landlock/bwrap) and the Windows sandbox implement
  precedence per-backend. The detector will *run* wherever the binary exists, so a Linux dev with
  a staged binary would be the first person to measure that platform — and a red there would be a
  true finding, not a nuisance. Nobody has done it.
- **`rust-v0.148.0` only.** That is the point of the detector, not a gap in it.
- **Approval escalation removed as a variable, not characterised.** Every server→client request
  is answered `denied`. Whether an *accepted* approval reruns a profile-denied command
  unsandboxed — and could therefore surface `credentials.enc` — is still unmeasured and deserves
  its own row. P2.306 flagged this; I did not close it.
- **The `network` section of permission profiles.** Measured only as an *effect* of the
  `:workspace` parent. No profile in any run set one, so Option C stays uncosted.
- **Whether the runtime surfaces a rejected profile to the user** (N1's second half).

---

## 5. Gates — with proof of work

| Gate | Result | Proof |
| --- | --- | --- |
| Zone tests (mutex) | **PASS** | `292 pass`, `0 fail`, `948 expect() calls`, `Ran 292 tests across 14 files. [19.88s]` — full `packages/codex-responses-adapter` via `bun scripts/bun-test-lock.ts run --label w2-zone2`. Zero skips (`grep -c skip` → 0), so the seven new tests ran rather than being silently gated out. |
| Detector alone (mutex) | **PASS** | `7 pass`, `0 fail`, `16 expect() calls`, `Ran 7 tests across 1 file. [28.56s]` |
| Re-break 1 (precedence flip) | **FAILS AS DESIGNED** | `4 pass`, `3 fail`, `Ran 7 tests across 1 file. [31.88s]` — exactly the three enforcement assertions |
| Re-break 2 (rejected profile) | **FAILS AS DESIGNED** | `4 pass`, `3 fail`, `Ran 7 tests across 1 file. [23.77s]` — `profileAccepted` `Expected: true  Received: false` |
| Package typecheck | **PASS** | `bun x tsc -p packages/codex-responses-adapter/tsconfig.json --noEmit` → exit 0, **0 lines of output**. It caught a real `TS2322` on first run (`match[1]` is `string | undefined`) that `bun test` had run green — fixed, then re-run. |
| eslint on zone | **NOT-RUN** | No eslint config exists for this package and no root lint script covers it — N4, re-verified with a positive control. Nothing to run; this is not a convenience skip. |
| `git diff --check` | **PASS** | exit 0 over both paths |
| Scope check | **PASS** | `git status --porcelain` over both paths is empty after commit; `git show --stat` on each commit shows exactly one new file |

No full-repo suite, per the implementation-first verification budget. Every output above was
redirected to a file and read whole — nothing was piped through `tail`.

---

## 6. Artefacts

Harness and raw output in `<scratchpad>/w2/`:

- `rebreak-sandbox-enforcement.test.ts`, `rebreak2-failopen.test.ts` — the two re-breaks (copies
  of the committed file with one mutated producer each; the repo tree was never mutated)
- `probe6-sandbox-off.ts` + `probe6-out.json` — the P2.323 three-arm capability matrix
- `probe7-parent-feasibility.ts` + `probe7-out.json` — the parent-feasibility / fail-open probe
- `run1.txt`, `run2.txt`, `rebreak.txt`, `rebreak2.txt`, `gate-zone-tests.txt`,
  `gate-zone-tests2.txt`, `gate-tsc.txt` — gate output

Host fixtures (`~/.cache/nessy-p2323-probe`, `~/.cache/nessy-p2323-probe7`) are probe leftovers;
the committed detector cleans its own (`~/.cache/nessy-codex-sandbox-detector`) in `afterAll`.
