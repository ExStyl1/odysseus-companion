# Codex sandbox — what is actually enforced, measured

Measured 2026-08-28 on macOS arm64 (Seatbelt backend) against the pinned
`codex-app-server`, `openai/codex` `rust-v0.148.0`
(`packages/codex-protocol/manifest.json`), with an isolated `CODEX_HOME` per
variant containing only a `config.toml`. Every configuration below is the
**verbatim output of `buildCodexConfigToml`**, driven the way `CodexAgent`
drives it (permission mode + the T1 master switch + the hardcoded credential
deny) — except §3, which is hand-written on purpose because our writer cannot
emit it.

This file exists because two propositions that look like one had already
diverged: *we emit a deny line*, and *the deny is enforced*. Rows P2.306
(refutation), P2.324 (detector) and P2.323 (measurement) are all about that gap.

---

## 1. The documentation says the opposite of what the binary does

`developers.openai.com/codex/permissions` 308-redirects to
`https://learn.chatgpt.com/docs/permissions`. Its intro, verbatim (the sentence
sits before the first heading, so no section anchor covers it):

> "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or
> the selected config profile sets `sandbox_mode`, Codex uses those older sandbox
> settings instead of `default_permissions`."

and `learn.chatgpt.com/docs/permissions.md#migrate-from-older-sandbox-settings`, verbatim:

> "Use one system or the other for a session, not both."

We emit **both**. By that page our `[permissions.nessy_runtime]` deny would be
ignored and `sandbox_mode` would govern.

**The pinned binary does the reverse.** P2.306 made the two systems disagree on
one axis in both directions and the profile won both times. The page is marked
"Beta. Permission profiles are under active development and may change." — so
**do not cite it as authority for our behaviour.** It is quoted here because the
binary contradicts it, which is precisely why the control needs an alarm.

That alarm is
`packages/codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts`
(P2.324). It asserts **enforcement** — a decoy credential read under a real
sandbox — never the emitted TOML, and every enforcement case is paired with a
control that must show the opposite result in the same run. It skips when the
codex binary is absent (it is gitignored, so CI's Linux container has none);
`NESSY_CODEX_SANDBOX_DETECTOR=required` turns that skip into a failure.

---

## 2. P2.323 — what "sandbox off" leaves in force

The shipped default is master switch OFF (`SANDBOX_ENABLED_DEFAULT = false`,
`packages/shared/src/config/sandbox-settings.ts`), which
`codexSandboxConfigForMode` maps to `sandbox_mode = "danger-full-access"`. But
`resolveRuntimePolicy` derives the profile parent as
`sandboxMode === 'read-only' ? ':read-only' : ':workspace'`, so
`danger-full-access` lands on **`:workspace`**; and `deniedReadPaths` is a
hardcoded literal at all three `CodexAgent` call sites (`codex-agent.ts:1254`,
`:1400`, `:2386`), so `hasFilesystemPolicy` is always true and **the profile
always ships**.

Emitted by the shipped default, verbatim:

```toml
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
default_permissions = "nessy_runtime"
[permissions.nessy_runtime]
extends = ":workspace"
[permissions.nessy_runtime.filesystem]
"<CONFIG_DIR>/credentials.enc" = "deny"
```

Three arms over `command/exec`, one row per capability. `off_true` is the
control — no deny passed, so no profile is emitted at all, which is what
"sandbox off" is supposed to mean.

| Capability | **OFF + deny (SHIPPED DEFAULT)** | OFF, no profile (control) | ON + deny |
| --- | --- | --- | --- |
| read inside workspace | ok | ok | ok |
| write inside workspace | ok, file landed | ok, file landed | ok, file landed |
| read ordinary file outside workspace | ok | ok | ok |
| **write outside workspace** | **refused** (`Operation not permitted`) | ok, file landed | refused |
| **read the denied `credentials.enc`** | **refused** | **secret read** | refused |
| **network — loopback HTTP** | **refused** (`curl: (7)`) | `200` | refused |
| **network — `https://1.1.1.1/`, no DNS** | **refused** (`curl: (7)`) | `301` | refused |
| DNS (`dscacheutil -q host`) | **exit 0, empty output** | resolves | exit 0, empty output |
| `ls $HOME` | ok | ok | ok |

**The shipped "sandbox off" column and the "sandbox on" column are identical on
every row.** Turning the master switch off changes nothing a user can observe on
the codex runtime.

Two consequences, opposite in sign:

1. **Good, and it was not known:** the credential deny is enforced *today*, in
   the default configuration. That is the P2.306 refutation, and it is why the
   sweep's recommended fix would have removed a working control.
2. **Bad:** an operator who deliberately disables the sandbox still gets a
   `:workspace` sandbox — and the part they will hit first is not writes, it is
   that **the agent's shell has no network at all**. `npm install`, `git fetch`,
   `curl`, any package manager: unreachable in every configuration this product
   ships. DNS is worse than blocked — `dscacheutil` exits **0** with empty
   output, so the failure reads as "no such host" rather than "denied".

The copy attached to that same `sandbox.enabled` switch says, verbatim
(`packages/shared/src/i18n/locales/en.json`, `settings.permissions.isolationDisabled`):

> "Isolation is turned off (sandbox.enabled), so none of the profiles below are
> applied."

On the codex runtime that is false. (Whether that exact string is rendered while
a codex connection is selected is a renderer question and was **not** checked —
the point is that this is the switch's own description.)

---

## 3. The option space, as measured — not a recommendation

The shape decision is the owner's. What follows is only what the binary permits,
so the options are costed against measurement rather than intuition.

`permissionProfile/list` reports three built-ins — `:read-only`, `:workspace`,
`:danger-full-access` — all with `allowed: true`. **That list is not a list of
usable parents.** Hand-written arms, identical but for the `extends` token:

| `extends` | profile `allowed` | credential read | write outside ws | loopback |
| --- | --- | --- | --- | --- |
| `:workspace` (what we ship) | `true` | refused | refused | refused |
| `:danger-full-access` | **`false`** | **secret read** | refused | refused |
| `:no-such-parent` (negative control) | `false` | secret read | refused | refused |

stderr from the binary, verbatim, on both rejected arms:

> `Invalid configuration; using defaults. permissions profile `nessy_runtime`
> cannot extend unsupported built-in profile `:danger-full-access``

So:

- **Option A — the affordance stops claiming to disable the sandbox.** Behaviour
  unchanged; the product tells the truth instead. Cost: copy and docs only, no
  runtime risk. What must then be accepted as permanent: no network from the
  agent's shell, in any shipped configuration, and a DNS failure mode that
  reports success.
- **Option B — `danger-full-access` really means full access.** Stop emitting
  the profile when the master switch is off. Cost is **measured, not guessed**:
  the credential deny goes with it — the `off_true` control read the decoy
  secret. There is no way in this pin to keep the deny by re-parenting, per the
  table above.
- **Option C — widen the profile instead of replacing its parent.** The schema's
  `PermissionProfileToml` (`packages/codex-protocol/schema/config-schema.json`)
  carries `network` and `workspace_roots` alongside `filesystem`, so the shape
  that keeps the deny *and* lifts the confinement plausibly exists. **Not
  measured.** Costing it needs a spike, and it is the only option that could
  satisfy both goals at once.

---

## 4. A separate defect this measurement surfaced: the profile fails OPEN

An `extends` the binary rejects — an unsupported built-in, a typo, or schema
drift on a future pin — does **not** produce an RPC error. It writes
`Invalid configuration; using defaults` to **stderr only** and discards the whole
`config.toml`. The credential deny disappears; codex's own default
`workspace-write` keeps refusing outside writes and network, so from every angle
except the credential read the session still *looks* sandboxed. The two rejected
arms above are that failure, observed.

`permissionProfile/list` reports our profile with `allowed: false` in exactly
that state — a cheap in-band signal that nothing in this tree currently consults.
The detector asserts it (`profileAccepted` must be `true` before the read
assertion runs), so a fail-open is caught in tests; whether the **runtime**
should also refuse to proceed on `allowed: false` is a separate decision and is
outside P2.324's scope.

---

## 5. Scope — what none of this establishes

- **macOS arm64 only** (Seatbelt). Linux (Landlock/bwrap) and the Windows
  sandbox implement precedence per-backend; nothing here covers them, and that
  residual is real.
- **`rust-v0.148.0` only.** The precedence behaviour is a property of this pin —
  which is the entire reason for the detector.
- **Approval escalation was removed as a variable, not characterised.** Every
  server→client request in these runs was answered `denied`, because an accepted
  escalation can rerun a command unsandboxed. Whether an accepted approval can
  surface `credentials.enc` is still unmeasured and deserves its own row.
- The `network` section of permission profiles was measured only as an *effect*
  of the `:workspace` parent; no profile in these runs set one.
