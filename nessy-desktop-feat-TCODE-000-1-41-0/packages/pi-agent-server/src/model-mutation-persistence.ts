/**
 * I2.29 — every model and thinking-level mutation this host makes is
 * SESSION-ONLY, said out loud at each call site instead of inherited.
 *
 * ## What changed upstream, re-derived at the vendored Pi 0.84.4 (2026-09-17)
 *
 * `@earendil-works/pi-coding-agent` `dist/core/agent-session.d.ts` declares
 * `ModelMutationOptions { persist?: boolean }` — *"Persist the new value to
 * global defaults. Defaults to session-only."* — and gives it to all four
 * mutators: `setModel(model, options?)`, `cycleModel(direction?, options?)`,
 * `setThinkingLevel(level, options?)`, `cycleThinkingLevel(options?)`. The
 * docblocks now read *"Persists to global defaults only when options.persist is
 * true"*; W10-g measured them at 0.84.3 as having previously *"saved to session
 * and settings"*. The implementation agrees: in `agent-session.js` the writes
 * `settingsManager.setDefaultModelAndProvider(...)` /
 * `_addPersistedDefaultToNonEmptyScope(...)` and
 * `settingsManager.setDefaultThinkingLevel(...)` each sit behind
 * `if (options.persist)`.
 *
 * ## Why `false`, at every one of this host's call sites
 *
 * The desktop owns this preference in its own config and hands it to Pi at
 * session creation; Pi's global defaults are a second store that could only
 * ever disagree with it. And on the ephemeral title/summary session a persisted
 * default would be an outright defect: the mini model would become the value
 * the user's next session opens with. So `false` is not merely the new default
 * being restated — it is the answer this host would give whichever way upstream
 * flips it.
 *
 * ## Why saying it explicitly is worth four arguments
 *
 * Two layers currently make the flip invisible here, and neither is a promise.
 * (1) None of the four sites asked for persistence. (2) The host builds every
 * session with `SettingsManager.inMemory(..., { projectTrusted: false })`
 * (`compat/pi-runtime-adapter.ts`), whose storage is `InMemorySettingsStorage`
 * — *"Create an in-memory SettingsManager (no file I/O)"* — so even
 * `persist: true` would write into a per-session object that is discarded.
 * An inherited default that decides what a user's next session opens with is
 * the silent-divergence class this fork has paid for repeatedly: the day either
 * layer changes, the call sites say what they mean and the pin beside them goes
 * red rather than the behaviour moving quietly.
 *
 * `cycleModel` and `cycleThinkingLevel` have NO host call site (0 occurrences
 * over `packages` and `apps` at HEAD, against `setModel` and `setThinkingLevel`
 * which have four between them) — the desktop always names the value it wants.
 * They are recorded here rather than wrapped, so a future caller finds the
 * decision already made.
 */
export const SESSION_ONLY_MODEL_MUTATION = Object.freeze({ persist: false });
