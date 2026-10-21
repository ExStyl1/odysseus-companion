# @nessy-agent/codex-protocol

Generated bindings for the upstream **codex app-server** JSON-RPC protocol.

## Status: consumed as DATA, never imported as TypeScript (P3.155, measured 2026-08-31)

**Nothing in this repo imports `generated/index.ts`, or any `generated/*.ts`, as a
module.** That is deliberate, and this section exists so the next reader neither
believes the opposite nor "fixes" a barrier that is not there.

What IS consumed, and how:

| Surface | Consumed as | Consumers |
| --- | --- | --- |
| `manifest.json` | a JSON module, through this package's `exports` map | `codex-agent-server/src/manifest-verifier.ts`, `server-core/src/pi-harness/isolation/windows.ts`, and that verifier's test |
| `manifest.json` | a file read by path | `scripts/build/codex-integrity.ts`, `scripts/cdp/lib/bundle.ts`, `scripts/cdp/cases/cdx-150.ts` |
| `schema/config-schema.json` | a file read by path | the `codex-responses-adapter` config-writer suites (7 files) and `codex-agent-server/src/spike.ts` |
| `generated/v2/HookEventName.ts` | **source text, parsed** | `shared/src/automations/runtime-hook-events.test.ts` |
| `generated/v2/ConfigRequirements.ts` | **source text, parsed** | `shared/src/agent/__tests__/codex-config-requirements.test.ts` |

The last two rows are the important ones: where a wire shape is restated by hand
in `shared`, the test that pins the restatement reads codex's own generated file
and asserts totality against it. That is the mechanism that catches a bad
regeneration, and a new hand-restated shape owes one.

### Why `shared` restates the wire shape instead of importing it

`@nessy-agent/codex-protocol` is not a declared dependency of
`@nessy-agent/shared` — recorded by P6.28 as "a package-boundary duplication,
deliberate and worth knowing". It is a duplication by CHOICE, not by
impossibility: this package declares no dependencies of its own, so there is no
cycle, and `shared` already depends on `codex-agent-server`, which depends on
this package. If a future row wants the stronger tie — keying a hand-written
verdict table on `keyof ConfigRequirements` so a regeneration reddens the
typecheck rather than a text parse — the obstacle is one line of
`packages/shared/package.json`, nothing more.

### What already checks these files

"Generated and therefore unchecked" is not true of this package, and the three
things that check it are worth knowing before adding a fourth:

- **ESLint.** `lint:codex-protocol` (in `lint:chain`) lints all 743 generated
  files under the full base rule set with no rule switched off — a correctness
  rule firing in generated output is a generator bug. (744 files linted, 0
  errors, 0 warnings at `rust-v0.162.0` — the 744th is this package's own eslint
  config; 735 at `rust-v0.159.3` over 734 generated, 727 at `rust-v0.156.1`,
  712 at `rust-v0.154.0`.)
- **The two drift ties above**, which parse the generated source.
- **`scripts/build/codex-integrity.ts`**, which ties `manifest.json`'s pinned tag
  and per-platform SHAs to the binaries actually shipped.

### The residual hole, measured and costed

`generated/*.ts` is in **no TypeScript program** — `packages/codex-protocol` has
no `tsconfig.json`, no `typecheck` script, and a named exclusion in
`scripts/check-typecheck-coverage.ts`. What that costs, measured 2026-08-31 with
both mutants restored by whole-file write and SHA-256 check:

- A regeneration that **drops a module three files still re-export**: ESLint exits
  **0** (every remaining generated file plus this package's config, 0 errors,
  0 warnings); `tsc` exits **2** with `TS2307: Cannot find module './AuthMode'`
  three times over. Only a type program sees this.
- A regeneration that **drops an enum member** (`"subagentStart"` out of
  `HookEventName`): `tsc` exits **0** — a type program is blind to it — while
  `runtime-hook-events.test.ts` reddens on two assertions.

So a typecheck here would gate exactly one shape of bad regeneration, the
dangling cross-file reference, and would not gate the semantic drift that the
hand-restated shapes actually suffer. It cost ~600 ms over all 655 files when it
was measured (twice, at load average 13.9, on the tag shipped then); the tree is
743 files at `rust-v0.162.0` (734 at `rust-v0.159.3`) and the millisecond figure
has not been re-taken. Wiring it in is **atomic
across three files** and
cannot be done in halves: `packages/codex-protocol/tsconfig.json`, a
`typecheck:codex-protocol` entry in the root `package.json` chain, and deleting
this package's exclusion from `scripts/check-typecheck-coverage.ts` — whose
staleness guard reddens on a tsconfig or a `typecheck` script appearing here with
nothing running it. For the same reason **a test file must not be added inside
this package** until that happens; the guard treats one as the P3.117 shape.

One property makes the claim at the top of this section self-limiting rather than
rot-prone: the moment any typechecked package imports a `generated/*.ts`, those
files enter that package's program transitively and `tsc` starts checking them.
The sentence "nothing imports them" and the hole it describes go away together.

### The bindings lag the binary, and always may

They are a view of the pinned tag, not of everything the shipped binary can do.
Re-measured 2026-10-10 (UA12.211) against
`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` at
`rust-v0.162.0` (occurrence counts — `grep -aoF … | wc -l`, NOT `grep -c`, which
counts binary "lines" and answers 1 for three strings that share one — with
`thread/start`=18, `turn/start`=21, `command/exec`=23 as positive controls and
two invented method names at 0 as the negative): the binary still declares
`thread/backgroundTerminals/list`, `…/terminate` and `…/clean` (1 each), and `generated/`
still emits no binding for any of them — the lift's regeneration did not change
that, which is the point of re-reading it rather than assuming. `event-adapter.ts` carries that case in full.
No typecheck can see a type the generator never wrote.

### Background terminals are DECLINED, not missing (P3.255, decided 2026-09-02)

The three methods above are the reason this section exists, and a future lane
will meet them again — either here, or the first time it wonders why a
regeneration was not run. **The gap is a decision, not an oversight, and the
decision is the capability rather than the bindings.**

Owner-delegated controller decision, 2026-09-02 (§F1): **decline codex
background terminals for now.** Not "unsupported", not "todo" — declined, with
the reason, so that nobody re-derives the absence as a defect and quietly closes
it.

The measurement holds; re-run 2026-10-10 on the binary the `rust-v0.162.0` lift
installed (UA12.211; the previous run was 2026-10-01 on the `rust-v0.159.3`
binary, F1.1215): `thread/backgroundTerminals/list` = 1, `…/terminate` = 1,
`…/clean` = 1; positive controls `thread/start` = 18, `turn/start` = 21 and
`command/exec` = 23; negative controls `thread/backgroundTerminals/zzzNotReal`
and `xyzzy/notAMethod` both 0. `grep -rl backgroundTerminals
packages/codex-protocol/generated/` returns nothing.

Why declined, and it is the native-first rule's SECOND half rather than its
first. The first half says: if the runtime already has the mechanism, enable it
instead of building one. Codex does have it. The second half says the host must
then make the residual difference **uniform or honest** — and here it can do
neither cheaply:

- **Pi and claude have no counterpart**, so adopting this makes a session's
  capabilities depend on which runtime it is on, which is the switch-safety
  problem itself.
- **No gate.** A terminal manager the host does not list cannot be permitted or
  refused per-session; every isolation row in the parity plan has this shape.
- **No observability.** Terminals we neither list nor own do not reach the
  session's running-work surface, so an operator cannot see what a session
  started. An unauditable capability is worse than an absent one.

**What is deliberately NOT done:** nothing is regenerated FOR THIS. The
regeneration has since happened anyway — P7.2's lift to `rust-v0.150.1` moved
all 688 files for reasons of its own — and it is worth saying what that did and
did not settle: it bought no background-terminal bindings, because upstream still
emits none, so the gap described above is unchanged and this decision is
untouched. What the original sentence was protecting was the COST of a
regeneration undertaken for this capability alone; that argument is now moot and
the decision it supported is not. The bindings gap stays, and is the cheaper of
the two states to reverse.

**What would reopen it:** a host-side gate and a place for the terminals to be
listed (the session's running-work surface, P6.57), plus a stated verdict for the
other two runtimes. Then the regeneration is mechanical.

**And do not read the binding absence as proof the methods are unusable.**
P3.155's own lesson is that *nothing references this* was refuted at 18 sites;
the binary answers these methods whether or not this package names them.

### `config-schema.json` and the binary disagree about `[features]`, in BOTH directions

`schema/config-schema.json` carries the `[features]` property list that
`validateConfigAgainstSchema` drift-guards the emitted toggle names against, so it
is the denominator this repo treats as authoritative. The binary publishes its
own list over the wire, and the two are not the same list. Re-measured
2026-10-10 (UA12.211) against the shipped `darwin-arm64` binary (SHA-256
byte-identical to this manifest's pinned `binarySha256`, self-reporting
`0.162.0`), `experimentalFeature/list` paged to exhaustion:

| | at `rust-v0.150.1` | at `rust-v0.154.0` | at `rust-v0.156.1` | at `rust-v0.159.3` | at `rust-v0.162.0` |
| --- | --- | --- | --- | --- | --- |
| `[features]` properties in `config-schema.json` | 134 | 149 | 158 | 161 | **176** |
| features the binary reports | 124 | 140 | 149 | 152 | **167** |
| in both | 123 | 138 | 147 | 150 | **165** |

At `rust-v0.156.1` both lists grew by nine and at `rust-v0.159.3` by three, and
both times the two difference sets did NOT move — the same eleven schema-only
keys and the same two binary-only keys named below (`guardianv2.thread_context`
is now at `stage: "removed"`). At `rust-v0.162.0` the schema grew fifteen and
the binary fifteen, and the difference sets STILL did not move: the same eleven
schema-only keys and the same two binary-only keys. That is one more reading,
not a property: the `rust-v0.154.0` paragraph
that follows is the proof that it can move.

**An earlier reading's headline was REFUTED by the `rust-v0.159.3` one, and the
refutation is the whole point of re-taking it.** At that lift the schema grew
fifteen, the binary sixteen, and the BINARY-ONLY set went from one key to two.
Eleven keys are still **schema-only**, the same eleven — `codex_hooks`,
`collab`, `connectors`, `enable_experimental_windows_sandbox`,
`experimental_use_unified_exec_tool`, `imagegenext`, `memory_tool`,
`request_permissions`, `telepathy`, `tool_registry`, `web_search`. The guard
would let us write any of them and the binary does not know them. **Two** keys
are **binary-only** — `artifact` (`stage: "underDevelopment"`,
`enabled: false`, unchanged through `rust-v0.162.0`) and
`guardianv2.thread_context` (itself now `stage: "removed"` on the wire at
`rust-v0.162.0`) — real features of the binary we ship that the
guard would refuse to let us write, since they are absent from the schema's
property list. So "the difference is stable" is not a property of this pair; it
was one reading, and a section that had settled into quoting it would now be
wrong about the one number it exists to report.

Note what that guard is and is not: it never validates the produced
`config.toml` against the schema. It asserts that the key NAMES this product
emits are still declared there, so the schema is the denominator for what we may
write, and the binary's list is the denominator for what would actually take
effect. Adopting `artifact` needs the schema regenerated, not merely a line
added.

Two measurements decide what a client can do about that, both with controls:

- **The binary does not enforce `additionalProperties: false` — and since
  `rust-v0.156.1` it SAYS so.** A `[features]` entry spelled
  `p2374_not_a_feature = true` still produces no error and `thread/start` still
  succeeds, but it now draws ONE `configWarning` — *"Codex is ignoring 1
  unrecognized configuration setting. Check for typos or deprecated settings."*
  naming `features.p2374_not_a_feature` — where `rust-v0.154.0` was silent (the
  same holds for an unknown name in `[otel]`, `[analytics]` or at the top level;
  measured 2026-09-24, F1.255). Positive control on the same rig: a malformed
  VALUE on a known key (`view_image = "yes"`) yields `configWarning` *"Invalid
  configuration; using defaults."* and a `failed to load configuration` on
  `thread/start`. So a key RENAMED upstream is ignored-and-announced rather than
  silently inert — still ignored, which is why `config-writer.ts`'s schema check
  is the only thing that refuses before spawn (its P2.509 comment).
- **`stage` is the only detector of an inert key; `enabled` is not.** Writing
  `view_image = false` (stage `stable`) moves its reported `enabled` to `false`.
  Writing `tool_search_always_defer_mcp_tools = false` (stage `removed`) leaves
  `enabled` at `true` — a withdrawn key reports the registry default and ignores
  config, and unlike an unknown name it draws NO `configWarning` (re-read at
  `rust-v0.156.1`). Both keys this product writes, `multi_agent` and
  `view_image`, are present in both lists at `stage: "stable"`, `enabled: true`,
  `defaultEnabled: true` — re-read on the wire at `rust-v0.162.0` (and at
  `rust-v0.159.3` before it), because that
  pair is the only reason the config-writer's drift guard does not refuse — so
  today the write lands; nothing but `stage` would tell us the day it stops.
  `in_app_browser` is `stable`/`enabled: true` on the same reading, which is the
  positive control `config/managed-in-app-browser.ts` was built against.

Stage vocabulary, from `generated/v2/ExperimentalFeatureStage.ts` and confirmed
on the wire at `rust-v0.162.0`: `beta` 4, `underDevelopment` 66, `stable` 52,
`deprecated` 4, `removed` 41 (167 in total; at `rust-v0.159.3` 3 / 58 / 47 / 4 /
40 for 152, at `rust-v0.156.1` 4 / 57 / 45 / 4 /
39 for 149, at `rust-v0.154.0` the same five
words scored 3 / 54 / 43 / 3 / 37 for 140, and at `rust-v0.150.1` 2 / 44 / 40 /
3 / 35 for 124). The five WORDS are the durable half — they come from the
generated enum — and the five counts are a reading with a date.

## Layout

- `generated/` — TypeScript types (`.ts`), produced by
  `codex app-server generate-ts --out generated`.
- `schema/` — JSON Schema bundle, produced by
  `codex app-server generate-json-schema --out schema`, plus the release asset
  `config-schema.json` (the `config.toml` schema).
- `manifest.json` — the pinned upstream release + per-platform binary SHAs
  consumed by `scripts/fetch-codex.mjs`.

## Pinned version

Generated from **`openai/codex` `rust-v0.162.0`** (app-server `0.162.0`, the
binary's own `--version`; lifted 2026-10-10, UA12.211). This tag added
`thread/attachmentOwner/list` on the request side and the
`thread/prediction/updated` notification — the latter classified into
`CODEX_UNREAD_NOTIFICATION_METHODS` — and opened `CodexErrorInfo` to upstream's
own passthrough (`| string | { [key: string]: unknown }`); nothing left the
protocol, and `PlanType` is unchanged (the 18 members incl. `promax` it has had
since `rust-v0.159.3`). At `rust-v0.159.3` (F1.1215)
`account/gatewayOAuth/{read,login,cancel}` and the `account/gatewayOAuth/changed`
notification arrived, with `PlanType` `promax` and the `CodexErrorInfo` members
`flexUnavailable` and `tooManyDenials`. At
`rust-v0.156.1` (F1.255) `thread/rollback` left (its `ThreadRollback*` files are
gone; `thread/revert` carries the history half) and `thread/attachment/*` arrived.

## Regeneration (on binary bump)

**Do not hand-edit** anything under `generated/` or `schema/` — the files carry
`GENERATED CODE! DO NOT MODIFY BY HAND!` headers.

The schema generators live in the **full `codex`** binary, not the standalone
`codex-app-server` we bundle (which is server-only and has no subcommands). To
regenerate, download the full `codex` binary for the same release tag and run:

```bash
codex app-server generate-ts          --out packages/codex-protocol/generated
codex app-server generate-json-schema --out packages/codex-protocol/schema
```

Then bump `manifest.json` (tag + archive/binary SHAs), re-run
`node scripts/fetch-codex.mjs`, and re-run the adapter conformance + integration
suites. The generated bindings MUST match the exact bundled binary version, and
`node scripts/check-codex-schema.mjs` is what proves it — it fetches the full
binary for the PINNED tag, regenerates into a temp dir and diffs.

### Three things the two commands above do NOT do (each cost a real step, 2026-09-11)

1. **`schema/config-schema.json` is a separate RELEASE ASSET, not generator
   output.** `generate-json-schema` neither writes it nor knows about it, so a
   lift that runs only these two commands either deletes it (if the directory is
   replaced) or silently leaves the PREVIOUS release's copy under the new tag. It
   has to be fetched on its own from
   `https://github.com/openai/codex/releases/download/<tag>/config-schema.json`,
   and it is the file the config-writer's `[features]` drift guard reads.
   `check-codex-schema.mjs` excludes it from the diff for exactly this reason, so
   the gate cannot catch a stale one either.
2. **The generators do not delete a file upstream has dropped.** Sync the two
   directories rather than writing over them — with `config-schema.json` excluded
   from the deletion, per (1).
3. **`fetch-codex.mjs`'s idempotent skip was blind to a tag bump** until the same
   date: it compared the on-disk binary against the manifest's own recorded sha
   and nothing else, so `--all` straight after the tag moved refetched nothing and
   left the previous release's binaries under the new manifest. It now also
   requires the recorded `archiveSha256` to match the release sums for the pinned
   tag. If a future lift sees "already present + verified" for every target,
   suspect that check before suspecting the network.

### Re-check on every bump: features we wait on (F1.1129)

A lift is also the moment to re-read the stage of the codex features a decision is
waiting on, in `codex-rs/features/src/lib.rs` (`FeatureSpec { key, stage,
default_enabled }`) at the new tag. A row adopts one only once codex marks it
`Stage::Stable`; until then the decision stands and the reading is recorded here.

| Feature key | What it would give us | Waiting row | Stage at `rust-v0.162.0` |
| --- | --- | --- | --- |
| `exec_permission_approvals` | an approved escalation that really widens what a command may do while it stays sandboxed (`with_additional_permissions`) — option C of F1.780 | F1.1129 | `UnderDevelopment`, `default_enabled: false` (re-read 2026-10-10 at `rust-v0.162.0`, `features/src/lib.rs:1284-1289` and on the wire; unchanged since the `rust-v0.159.3` reading of 2026-10-09) |

Update the stage column on each lift; when a row turns `Stable`, open the row that
adopts it.

## Protocol notes (Phase 1 spike)

- Transport: newline-delimited JSON-RPC 2.0 over stdio (the wire omits the
  `"jsonrpc"` field). The bundled `codex-app-server` defaults to
  `--listen stdio://`; spawn it with **no transport flag** (it does not accept
  `--stdio`; only the full `codex app-server` subcommand does).
- Handshake: `initialize` (client→server request) → `initialized`
  (client→server notification). Response carries `codexHome`, `platformFamily`,
  `platformOs`.
- The v2 protocol (`generated/v2/`) carries the `thread/*`, `turn/*`, and
  `item/*` messages. Approvals are **server→server-request**
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
  answered with a fixed decision enum (`accept` | `acceptForSession` |
  `decline` | `cancel` | amendment variants) — there is no `availableDecisions`
  field.
