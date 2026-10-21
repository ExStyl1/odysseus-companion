# User-scope `env` — the park (f163b)

**Status: PARKED. Do not implement without an explicit owner threat-model
decision.** This file exists so the next reader does not "finish" f163a by
wiring the block into `process.env`; the missing piece is a decision, not code.

Unit R31, dispatch B, landed **f163a only**. See
`docs/superpowers/plans/2026-08-04-doc-sweep-parity-wave.md` §
"R31 · managed-settings-key-vocabulary · decision", constraint 1, and
`docs/superpowers/specs/data/phase25-specs/f163.json`.

## What landed (f163a)

`env` is DECLARED in `StoredConfigKnownFields` (`packages/shared/src/config/validators.ts`)
and on `StoredConfig` (`packages/shared/src/config/storage.ts`), so a
`~/.nessy-agent/config.json` that carries the documented key still loads. Before
that, `StoredConfigTopLevelSchema` is `.strict()` and `loadStoredConfig()` throws
`UnsupportedStorageLayoutError` on a failed parse, so following the page cost the
user **every** setting in the file — not just this one.

The value is ignored, and the fact is reported: `reportUnhonouredUserEnvBlock()`
in `packages/shared/src/config/storage.ts` records a `RejectedSettingsLayerV1`
through `collectRejectedUserSettingsLayers()`, which is what reaches
`config/config-doctor.ts`. It names the variable NAMES and never a value.

## What is parked (f163b), and why

**documented, not implemented — `env-vars.md:78` makes a settings-file `env`
block readable at user scope and `:104` applies each entry to the process
environment "replacing the value inherited from the shell", but
`~/.nessy-agent/config.json` has no write containment against the agent's own
Bash tool, so honouring a user-scope `env` block is unprompted code execution in
the HOST process, plantable by one shell redirect from a prompt-injected turn and
persistent across restarts; the key is declared so the file still loads and the
value is ignored and reported instead.**

Two supporting facts, both verified on this code:

1. `packages/shared/src/agent/pi-harness/protected-paths.ts` § "Known limits
   (deliberate)" scopes the protected-path floor to "File tools only" and routes
   a Bash redirect to the OS sandbox's deny roots
   (`isolation/self-config-deny.ts`), "which covers the config directories but
   not the shell rcs". That sandbox is **off by default**
   (`macosSeatbeltBashSandboxEnabled: false`, `FALLBACK_CONFIG_DEFAULTS` in
   `config/storage.ts`), so the unprotected case is the default install.
2. Every child process spreads `process.env` — Pi (`agent/pi-agent.ts`), the
   Claude SDK subprocess (`agent/options.ts`), supervised plugin processes and
   stdio MCP servers (`config/proxy-env.ts:getProxyEnvVars`). A user `env` block
   therefore reaches `PATH`, `HTTP(S)_PROXY` and `NODE_EXTRA_CA_CERTS` for every
   backend, which is exactly why the MANAGED tier classifies those categories
   (`config/managed-env.ts:MANAGED_ENV_WITHHELD_CATEGORIES`).

The managed tier already has the whole mechanism —
`parseManagedEnvBlockV1` (`agent/pi-harness/managed-policy.ts`), `applyManagedEnv`
and `startManagedDeliveryEnvApplication` — so the implementation would be small.
That is the trap: the cost is not the code.

## What an owner decision has to settle before this can be built

**Re-measured against HEAD 2026-09-04 (P3.373). Three of the four questions
below were WRONG as written**, in ways that would have sent an implementer at
the wrong answer, so each carries its correction inline. The corrections are
marked because a reader who trusts the original wording gets a menu with a
foreclosed option on it and a category list that names a category this codebase
does not have.

1. **Containment.** Is a user-scope `env` block acceptable at all while
   `config.json` is writable by the agent's own Bash tool? ~~If not, does the fix
   go to containment (deny the config dir unconditionally, not only under the OS
   sandbox) or to a narrower carve-out (an allowlist of harmless names)?~~

   **CORRECTION — this is a TWO-option question, not three.** The OS-sandbox
   containment route is foreclosed by the standing owner decision of
   2026-08-12/13 that isolation is off and is not coming back. And measured on a
   real darwin rig for P3.330 on 2026-09-04, the one remaining darwin write
   floor for approved Bash contains nothing either: with
   `SEATBELT_TESTING_WILDCARD` on, a write to `~` under the shipped wrapper
   returns status 0 and creates the file, where the strict profile returns
   `Operation not permitted`. So "the sandbox will contain it" is not available
   in either spelling today. What remains is: an unconditional non-sandbox write
   floor on the config directory, or a name allowlist.

2. **The withheld categories.** Should the user block refuse the managed
   withheld categories outright? ~~the four managed withheld categories
   (transport, routing, credential, provider)~~

   **CORRECTION — there are FIVE, and `provider` is not one of them.**
   `config/managed-env.ts MANAGED_ENV_WITHHELD_CATEGORIES` reads
   `transport`, `routing`, `credential`, `execution`, `selector`. Two are missing
   from the sentence above and one is invented. The most load-bearing omission is
   **`execution`** — "which binary a shell-out resolves to", i.e. the `PATH`
   case — which is the single most dangerous name a user `env` block can carry
   and the one this park's own threat model is built on. Any refusal must be
   stated against the real five.

   `config/types.ts:19-25` records that nothing a `git clone` can carry may
   redirect the process's TLS/proxy path; a user `env` route to
   `NODE_EXTRA_CA_CERTS` would sit beside that decision, not under it.

3. **The `NODE_EXTRA_CA_CERTS` rung.** `config/proxy-env.ts` documents the ladder
   managed-env > user `tlsCaPath` > operator shell env > bundled resource and has
   no representation for "user settings env". A block written into `process.env`
   enters as an indistinguishable operator-shell value and could silently
   outrank `tlsCaPath`. Picking a rung is a decision, not a derivation — and it
   sits BESIDE the recorded `config/types.ts` decision rather than under it,
   which is why it cannot be inferred from the ladder's existing order.

4. **Local scope.** `env` is refused at PROJECT scope on the record
   (`plugins/project-config.ts:FORBIDDEN_SECTIONS`), and LOCAL scope has no Nessy
   file at all. Neither a local file nor a recorded refusal exists; the same
   decision should cover it. **Still true at HEAD**, and it is the asymmetry that
   makes the park incomplete rather than merely unbuilt: one scope errors, one
   scope reports, one scope has no answer at all.

## The pin was lost, and is restored as a test (P3.373)

Live case `MS-3` was written to catch exactly this park being silently
"finished" — a turn that echoes a variable named in a user `env` block must find
it unset, and `doctor` must list it under **Rejected settings layers** by name
and never by value. At HEAD `MS-3` greps to **0** in
`docs/testing/cdp-live-checklist.md`; it survives only in the archived narratives
under `docs/testing/cdp-runs/`. So the guard against a silent finish had itself
silently gone.

It is restored as `packages/shared/src/config/__tests__/user-env-block-park.test.ts`,
which is stronger than the case it replaces: it runs on every `bun test` rather
than on a packaged-build day, and it asserts both halves — the block never
reaches `process.env` (with `PATH` in the fixture, the `execution` case), and the
rejected-layer report names the variables without carrying their values. If the
owner decides to honour user `env`, that file goes red ON PURPOSE, which is the
difference between a decision taken and a park forgotten. Re-adding the `MS-3`
row to the live checklist is a one-line append the close-out lane owns, since
that file is shared.

## The decision, as two options with their costs

Written for the sitting; **not taken here.** The code is the cheap half —
`parseManagedEnvBlockV1` and `applyManagedEnv` already exist and the managed
tier already classifies every category — so what is being bought is a posture,
not an implementation.

**(A) Refuse permanently, and say so once.** Keep the value ignored, keep the
rejected-layer report, and close f163b as *declined* rather than *parked*, with
the reason in the key's own docblock and one line in the config reference.
Cost: a documented `env-vars.md` key that this product will never honour, which
is a real divergence from the page and has to be disclosed as one. Benefit: the
threat model needs no new answer, and the four questions above stop being owed.

**(B) Honour it behind a name allowlist.** Apply only names in no withheld
category — the real five — refusing `execution`/`transport`/`routing`/
`credential`/`selector` names by name, with the refusal reported through the
same rejected-layer channel. Cost: three of the four questions above must still
be answered first (the `NODE_EXTRA_CA_CERTS` rung is a choice, LOCAL scope needs
its own answer, and an allowlist is only as good as the classification behind
it), and the config file remains writable by the agent's own Bash tool, so the
allowlist is the ONLY containment — there is no second floor under it. Benefit:
the documented key does what the page says for the names where doing so is
harmless.

A third shape — honour everything and contain the file — is what question 1's
correction removes: there is no containment left to lean on.

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| f163a — declare `env`, ignore and report the value | ✅ | (R31 dispatch B) | landed in `validators.ts` / `storage.ts` |
| f163b — honour a user-scope `env` block | ⏸ | — | parked; needs the four owner decisions above, THREE OF WHICH WERE MISSTATED — see the corrections (P3.373, 2026-09-04) |
| P3.373 — re-measure the menu, restore the lost pin | ✅ | (W5-e) | corrections inline above; pin restored as `config/__tests__/user-env-block-park.test.ts`; the two owner options are written above and NOT taken |
