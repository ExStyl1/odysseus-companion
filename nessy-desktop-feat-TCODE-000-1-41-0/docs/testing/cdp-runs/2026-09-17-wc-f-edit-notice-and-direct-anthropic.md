# RS-40 / DA2.24 and RS-16 / DA2.21 — the EDIT-form notice, and the DIRECT anthropic card (packaged 1.39.0)

Lane WC-f, wave C of the dp-auth wave-2 plan. Driven **2026-09-17 16:33–17:01**, load 6.9–11.2 throughout.

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.39.0** (the bundle self-reports `1.39.0`; built
from `b1f4f279c`). A FRESH `NESSY_CONFIG_DIR` and `--user-data-dir` under the lane scratchpad per rig, port **9227**,
never the owner's profile. Every card this lane created carries a **fabricated** key it generated for the run —
43 characters for the direct Anthropic card, 39 for each of the others — never a real credential, never printed and
never written to any file. The one-click gateway card is the app's own `dp` sign-in reading its own file; nothing here
touches it, and it is used only as a control.

Both rigs are seeded by `RS-32` before the case under test: a profile that has never been set up shows the
ONBOARDING wizard, so `listLlmConnections()` is empty, `nessy-agent-navigate` reaches no settings page, and every arm
reads as "the surface is missing". That cost one whole RS-40 run, which is why it is written here rather than left as
rig lore.

---

## RS-40 arm 3b (DA2.24) — `apiSetup.gatewayHostNotGatewayUrl`, read off the EDIT form

### What was owed

The 1.39.0 release sitting proved DA1.10's credential half end to end and recorded DA1.11's NOTICE as a **NULL**. Not
as missing: the ADD flow has no endpoint field to type a URL into — `ByoRuntimeStep.tsx` hides the endpoint in v2 and
renders it read-only on an EDIT — so the sentence is an EDIT-path surface, and that sitting did not drive the
per-connection menu that opens the form. The owed arm was one that opens it and reads the sentence off the DOM.

### The measurement

Driven `bun run scripts/cdp/cases/rs-40.ts` against the packaged app launched with `NESSY_PROXY_AUTH_DEBUG=1` and
`NESSY_DEBUG=1`. **RS-40 PASS 6 of 6 checks, 128 602 ms, load 8.8.**

| what | reading |
| --- | --- |
| the stored connection | `pi-api-key-3`, `pi_compat`, `…/api/v1/cli/other/v1` |
| the settings LIST, same screen, moments earlier | notice **ABSENT** |
| the EDIT form (opened through the «…» menu → Edit) | `#byo-api-key` present, `#byo-base-url` present (read-only), notice **PRESENT** |
| the ADD flow's custom-runtime step | API-key field present, `#byo-base-url` absent, `#base-url` absent |
| the credential half (re-confirmed, not this row) | control session `nestor-token`; gateway-HOST session `bearer`, `bearer` |

So the NULL is a verdict: **the notice is rendered, on the EDIT surface and on nothing else.** The list reading is the
arm's own negative control — the two readers of the key are `ApiKeyInput.tsx` and `ByoRuntimeStep.tsx`, and the
settings list is neither, so a PRESENT reading on the form cannot be a page that always carries the sentence.

### The rig fault that looked exactly like a product finding

The first version of the locator walked **up from the trigger**. `SettingsRow` renders the label cell and the actions
cell as SIBLINGS, so walking up from a trigger reaches the section container — whose `innerText` carries every
connection's name — and the first trigger in the list matches whatever name you asked for. It opened the **one-click
gateway card's** menu instead, and `canEditLlmConnection` is false for a managed card, so that menu correctly carried
no Edit item. The arm read `the open menu carried no Edit item in either locale`, which is indistinguishable from
"the product offers no way to reach the notice". The locator walks **up from the name** now, stopping at the first
ancestor that contains a trigger, and matches a leaf whose whole text is the name.

### And the instrument variable nobody had written down

Without `NESSY_DEBUG=1` the app writes no `<config dir>/logs/runtime/` directory at all, so RS-40's DA1.10 arm reads
an empty scheme list and fails as *"the instrument is off"* — which its own failure message predicts, and which cost
one run here. `NESSY_PROXY_AUTH_DEBUG=1` alone is not enough. Both variables, together.

---

## RS-16 arm 0 (DA2.21) — the DIRECT `anthropic` card

### What was owed

DA2.13 drove three BYO cards on 1.38.0 and named one NULL. `claude-agent.ts` symbol `postInit` sends only
`providerType === 'claude-runtime'` to the adapter that writes the `not-needed` placeholder; every other type takes
`resolveAuthEnvVars`, and `llm-connections.ts` puts the connection's REAL key under `ANTHROPIC_API_KEY`.
`APISetupStep.tsx` ships the direct card, so the question was live and unmeasured.

### Why the shell probe cannot reach this card — a product rule, not a rig limit

`BUILT_IN_CONNECTION_TEMPLATES['anthropic-api']`
(`packages/server-core/src/domain/connection-setup-logic.ts`) declares
`providerType: (hasCustomEndpoint) => hasCustomEndpoint ? 'pi_compat' : 'anthropic'`. **The moment a base URL is
present the card stops being a direct anthropic connection**, so it cannot be pointed at the loopback stub at all.
The only shape that exists is the one pointed at the vendor; a fabricated key gives a 401, a 401 gives no turn, and
no turn gives no shell.

So the arm reads the SDK child's **own process environment** for the LENGTH of each name, never a value. The
inference to the shell is DA2.13's own measurement rather than an assumption: a `claude-runtime` child's shell
reported `ANTHROPIC_API_KEY` present at exactly the length of the placeholder its environment carried, so on this
runtime the shell sees what the child's environment holds.

### The measurement

`NESSY_CDP_DIRECT_ANTHROPIC=1 NESSY_CDP_BYO_CARD=pi-api-key-2 NESSY_CDP_GATEWAY_CARD=pi-api-key`.
**RS-16 PASS 12 of 12 checks, 105 378 ms, load 10.0.**

| arm | card key | child's `ANTHROPIC_API_KEY` | verdict |
| --- | --- | --- | --- |
| DIRECT `anthropic` (`anthropic-api`, no base URL) | 43 chars | **43** | **REACHABLE** |
| CONTROL — `claude-runtime` (`claude-custom`) | 39 chars | **10** (`not-needed`; `CLAUDE_CODE_OAUTH_TOKEN` at 0) | not reachable |
| BYO `pi_compat` at the stub (shell probe) | 39 chars | — | not reachable |
| gateway `pi-api-key` (shell probe) | — | — | not reachable |

The control is two-sided on purpose: the two cards carry keys of DIFFERENT lengths, so a child reporting its own
card's key and a child reporting a placeholder are separable readings rather than one number. The absent-variable
control held in the child environment too, and the two shell arms parsed 9 `NAME=<length>` lines each — eight names
from `PROVIDER_KEY_ENV_NAMES` (DA2.20) plus the absent control. The stub's own JSONL transcript carries three records,
`authorizationLength` only ever 0 or 46 (`Bearer ` + the 39-character card key), and **zero** `sk-` occurrences, which
is the privacy control on the instrument itself.

### The posture is the owner's, and the case says so where it is read

On a DIRECT Anthropic connection the key in `ANTHROPIC_API_KEY` is the SDK's own documented mechanism — the user
supplied that key, for that vendor, on a card whose whole purpose is to spend it — so this is native-first working
rather than a divergence. **Recommendation, recorded and not decided here:** accept it as the mechanism WITH a
disclosure on the card, and keep the adapter path's placeholder as the answer wherever the host holds the credential
instead (the gateway cards and every `claude-runtime` card). The opposite choice — routing a direct Anthropic
connection through a local adapter so the child never sees the key — buys nothing the user did not already consent to
and costs a second credential path to keep correct.

### The trap this arm was written around

A process-table sweep for *"a claude process"* reads **other claude installs running on the same machine**. On this
rig the naive version found eight, belonging to the developer's own tooling, and reported their credential lengths.
The filter is the BUNDLED binary path inside the app bundle (`…/Nessy Desktop.app/Contents/Resources/app/node_modules/
@anthropic-ai/claude-agent-sdk-binary/claude`) **plus** the packaged app's own pid as parent, and the arm records how
many candidates each filter left — `bundledClaudeChildren: 0` before either session, exactly one new child after each
— so a reading taken from the wrong process cannot pass as this one's.

A smaller one, paid twice: the app refuses to delete a connection a session still uses
(`1 session(s) … still use "<slug>"`), so the cleanup moves every session it created to a fallback card before
deleting.

---

## Rig processes at exit

None. The packaged app and the loopback stub upstream (port 9332) are both stopped.
