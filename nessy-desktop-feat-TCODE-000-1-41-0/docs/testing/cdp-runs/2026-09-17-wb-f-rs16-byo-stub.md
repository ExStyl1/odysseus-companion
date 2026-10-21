# RS-16 / DA2.10 + DA2.13 — the BYO arm, against the loopback stub upstream (packaged 1.38.0)

Lane WB-f, wave A2 of the dp-auth wave-2 plan. Driven **2026-09-17 08:31–08:48**, load 7.8–10.4 throughout.

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.38.0** (built from `a40a13193`; the bundle
self-reports `1.38.0`). A FRESH `NESSY_CONFIG_DIR` and `--user-data-dir` under the lane scratchpad, port **9225**,
never the owner's profile. Every BYO card carries a **fabricated** `sk-cdp-<32 hex>` key this lane generated — 39
characters, never a real credential, never printed. The gateway card is the app's own one-click `dp` sign-in reading
its own file; nothing here touches it.

## The row, and why it had never produced a reading

RS-16 asks: **on a BYO connection, can the model's own shell read the provider key out of its process environment**,
with the SAME probe on the gateway path as the control, where the answer must be no. Rig day 2026-09-12 (lane R2,
packaged 1.37.0) got `byo-classification.shellToolCalled: false` against the gateway control's `true`. Nothing was
broken: a BYO card exists to carry its own key, a key its upstream rejects gives no turn, and no turn gives no
shell — so a fake credential cannot measure the arm at all. C3.356 built `scripts/cdp/fixtures/stub-upstream.ts`, a
loopback OpenAI-compatible upstream that needs nobody's credential, precisely so it could.

## Two defects in the INSTRUMENT stood between the row and a reading (DA2.10)

Both were found by driving it, and both are fixed.

1. **The stub's own transcript could not be read by a sitting at all.** `requests()` is in-process, and a sitting
   drives the app from a different process, so the server's view of the turn was lost the moment it was stopped. It
   now takes `--log <path>` and mirrors each record to JSONL as it arrives — the same instrument, and the same
   argument, as `scripts/cdp/fixtures/refusing-proxy.ts`'s log. It stays safe for the same reason the in-memory
   record does: `StubRequestRecord` carries the Authorization header's **length** and never its value.

2. **The stub sent `{ command }` to every shell tool, and codex's `exec_command` takes `cmd`.** The codex BYO turn
   died inside codex with `failed to parse function arguments: missing field \`cmd\` at line 1 column 243`; no tool
   ran, and RS-16's own `shellToolCalled` control went false — which is **byte for byte the symptom of the credential
   failure this fixture exists to remove**. One runtime's argument name, spelled as a constant in the harness, was
   enough to make the instrument blame the product for its own defect, on the one runtime nobody had yet driven.
   `shellArgumentName` now reads the property out of the chosen tool's OWN schema; a tool that offers no schema keeps
   `command`, the OpenAI-shaped default every other client sends. With the fix, the same codex arm answers.

## The arms

Three BYO cards, all pointed at the stub, each driven once with the gateway card `pi-api-key` as the control in the
same run. Every arm's three controls held: a shell tool ran in BOTH arms, BOTH arms printed seven `NAME=<length>`
lines to parse, and the variable that exists nowhere (`NESSY_RS16_NO_SUCH_VARIABLE`) was reported absent in both.

| BYO card | providerType | shell tool the stub drove | BYO names present | gateway names present | run | duration |
| --- | --- | --- | --- | --- | --- | --- |
| `pi-api-key-2` | `pi_compat` (custom endpoint) | `bash` | none | none | **PASS** | 106 s |
| `claude-custom` | `claude-runtime` | `Bash` | `ANTHROPIC_API_KEY` (**10 chars**) | none | **FAIL** (see below) | 130 s |
| `codex-custom` | `codex-runtime` | `exec_command` | none | none | **PASS** | 63 s |

## The verdict, per runtime (DA2.13)

- **pi — NOT REACHABLE.** The agent's own shell printed `0` for all six provider-key names.
- **codex — NOT REACHABLE.** Same, on the arm that could not be driven at all before the argument-name fix.
- **claude (`claude-runtime`) — the NAME is reachable; the KEY is not.** The shell reported `ANTHROPIC_API_KEY` present at **10
  characters**. Ten is the length of `not-needed`, the literal placeholder the host writes into the child's
  environment on this path — `packages/shared/src/agent/claude-agent.ts` symbol `startLocalAdapterRuntime`: *"The
  adapter authenticates upstream itself; the SDK still refuses to start without \*something\* here."* The card's own
  key is 39 characters. So the value the model's shell can read is the host's placeholder, and the credential never
  enters the child at all.
- **gateway — NOT REACHABLE, in all three runs**, which is the answer the row requires of the control.

The counts are what make that a verdict rather than a scare. With `namesReportedPresent` alone, the claude arm reads
identically to a leaked key; the case now records `lengthsOfNamesPresent` beside it — a character count, never a
value, inside the same privacy envelope the case's own docblock already argues for — and the two readings separate.

**No divergence is raised, and the reason is stated rather than assumed.** The row asks for *"any reachable arm
turned into a named divergence"*. The reachable thing here is a variable NAME whose value is a constant the host
chose; the SDK requires the variable to exist, and writing a placeholder rather than the credential is what keeps the
key host-side. That is the row's own native-mechanism clause working — *"Ours, and it IS the page's recommended
pattern"* — not a divergence from it.

## What the stub's own transcript adds that the classifier cannot

26 records over the sitting, and three facts the app-side reading cannot supply:

- **`authorizationLength` is only ever `0` or `46`.** Forty-six is `Bearer ` (7) plus the fabricated 39-character
  card key — so **the key really did travel from the card to the upstream on every BYO turn**, which is exactly the
  half a rejected fake credential could never prove. Taken with the 10 the claude arm's child reported, the two
  numbers together show the split: the credential goes out on the wire from the HOST, and the child holds a
  placeholder.
- **Three second-leg records** (`carriedToolResult: true`), one per runtime: the tool call was made, ran, and its
  output came back as the assistant's answer. That is the shell the whole verdict rests on, seen from the far end.
- **Three different shell tool names** were offered by the three runtimes — `bash`, `Bash`, `exec_command` — which is
  what the argument-name defect was hiding behind.

The log holds no credential: `sk-` does not occur anywhere in it. That is the privacy control for the instrument
itself, and it is checked rather than asserted.

## The arm this sitting did NOT drive, and it is the one to drive next

**`claude-runtime` is not the only claude card, and the two paths write the child's environment differently.** Read
at HEAD after the arms were taken: `packages/shared/src/agent/claude-agent.ts` symbol `postInit` branches on
`connection.providerType === 'claude-runtime'` and hands that case to `startLocalAdapterRuntime`, which is where the
`not-needed` placeholder is written. **Every other providerType falls through to `resolveAuthEnvVars` and then
`process.env[key] = value` for every entry it returns** — and
`packages/shared/src/config/llm-connections.ts` returns `ANTHROPIC_API_KEY = apiKey`, the connection's real
credential, for `authType` `api_key` / `api_key_with_endpoint` / `bearer_token` whenever a key exists (it returns
`'not-needed'` only for a KEYLESS provider such as Ollama). `buildClaudeSubprocessEnv` spreads `process.env` into the
child.

A direct `anthropic` card is reachable in the shipped product —
`apps/electron/src/renderer/components/onboarding/APISetupStep.tsx` builds
`{ providerType: 'anthropic', authType: 'api_key' }` — so this is a live card and not a dormant branch.

**So the claude verdict above is about `claude-runtime` and says nothing about a direct `anthropic` connection**, and
on the source reading that arm looks REACHABLE. It is recorded as a NULL rather than asserted, because this sitting
did not drive it and a verdict from a source read is a hypothesis about the binary, not a measurement. It is also not
obviously a defect: on a direct Anthropic connection an `ANTHROPIC_API_KEY` in the child's environment is the SDK's
own documented mechanism, which is the opposite of the adapter path where the host deliberately keeps the credential
out. The next sitting adds one arm — a BYO `anthropic` card with a fabricated key — and the answer is one run away.

## One caution for the next reader

This sitting measures a **BYO card whose upstream is the stub**. A BYO card pointed at a real vendor exercises the
same host code path and the same env construction — the child's environment does not depend on who answers — but it
also spends a real key, which is why the stub exists. The verdict above is about what the child can READ, and that is
decided before any request is sent.
