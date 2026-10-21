/**
 * **P3.137 — the `pi_compat` undeclared image default, in ONE place because it
 * has always had to hold in TWO.**
 *
 * When a `pi_compat` (custom endpoint) model declares nothing about image input,
 * the answer is `false`. That value is not a prediction about the model — every
 * other provider type answers `true` and lets the endpoint refuse, per the
 * owner's 2026-08-28 ruling (*carry the modality faithfully, the ENDPOINT
 * answers*). It is `false` here for one reason and one only: **it is the value
 * we ourselves write into Pi's registry**, so answering anything else would make
 * the host and the runtime disagree about the same model.
 *
 * The two readers, and why a change to either alone is a defect rather than a
 * partial improvement:
 *
 * 1. `config/llm-connections.ts` `modelSupportsImages` — the HOST's answer. It
 *    gates the composer's staged-image warning, the one-click override, and the
 *    send-time strip (`server-core/src/sessions/runtime-config.ts`).
 * 2. `pi-agent-server/src/custom-endpoint-models.ts` `buildCustomEndpointModelDef`
 *    — the RUNTIME's answer. The same `overrides ?? defaults ?? <this>` becomes
 *    `input: ['text']`, and pi-ai then honours it: `api/transform-messages.js`
 *    `downgradeUnsupportedImages` replaces every image block with
 *    `(image omitted: model does not support images)` when `model.input` lacks
 *    `"image"`.
 *
 * **Move one and you get a placeholder, not a refusal.** Flipping (1) to `true`
 * alone stops the host reporting the omission — no warning, no strip, the send
 * allowed — while pi-ai goes on substituting its own *(image omitted)* text and
 * the endpoint still answers nothing about an image it never received. Flipping
 * (2) alone leaves the host refusing a send the runtime would have carried. So:
 * **both or neither**, which is what this constant makes structural instead of a
 * coincidence between two files that never mention each other.
 *
 * ## Why a leaf module with no imports
 *
 * The Pi reader lives in another package and reaches into this one by relative
 * path (`../../shared/src/…`). Exporting the value from `llm-connections.ts`
 * would drag that module's whole graph — the model registry, the Bedrock id
 * helpers, a `CredentialManager` type — into the Pi subprocess for one boolean.
 * Same discipline, and the same reason, as `managed-model-allowlist.ts`: no
 * imports at all, so anything may read it.
 *
 * Both readers import this constant since W3-i landed reader (2)'s line (wave 3,
 * P3.137 hand-off) — the residue this header used to name is closed, and the
 * coupling is mechanical rather than documented. The test beside this module
 * pins the host half against the constant; `custom-endpoint-models.test.ts`
 * exercises the runtime half through `buildCustomEndpointModelDef`.
 */

/**
 * What `pi_compat` answers for a model that declares no image support at any
 * scope. See this module's header before changing it — it has a second reader
 * in `pi-agent-server`, and the two move together or not at all.
 */
export const PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES = false
