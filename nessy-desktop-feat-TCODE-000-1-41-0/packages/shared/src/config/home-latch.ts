/**
 * The session's home directory, resolved once and held — P3.143.
 *
 * ## What moves, and in which runtime
 *
 * `config/managed-env.ts` withholds `HOME` from an unconfirmed server-fetched
 * cache (P3.133). That closes the pre-confirmation half. The other half is
 * this file: once the fetch confirms, `applyManagedEnv` writes the
 * administrator's `HOME` into `process.env` — deliberately, because a
 * subprocess inheriting it is the operator control the doc points admins at —
 * and an UNCACHED `os.homedir()` then answers the new value for the rest of
 * the session.
 *
 * **Measured 2026-08-28, and the runtimes disagree — which is the fact this
 * module exists to survive:**
 *
 * | runtime | `HOME` at spawn | `process.env.HOME` set mid-process |
 * | --- | --- | --- |
 * | Node 24.4.1 | honoured | **`os.homedir()` follows it** |
 * | Electron 39.8.10 (Node 22.22.1) | honoured | **`os.homedir()` follows it** |
 * | Bun 1.3.14 | honoured | ignored — latched at startup already |
 *
 * Positive control on the same rig, all three: with `HOME` unset the call
 * returns the passwd entry (`/Users/…`), so the probe was reading the variable
 * and not a constant.
 *
 * The process that matters is the one that does BOTH things — applies the
 * managed block and resolves the credential path — and that is the Electron
 * main process (`apps/electron/src/main/index.ts` calls
 * `startManagedDeliveryEnvApplication()`; `handlers/nessy-auth.ts` reads the
 * creds file in the same process). It is Node. So the move is live, and it is
 * not hypothetical in a Bun-only sense.
 *
 * ## Why a latch and not a second withhold
 *
 * `HOME` is a legitimate operator control and P3.133 already ruled that
 * refusing it has no contract behind it. A latch keeps the control — the
 * confirmed value still reaches `process.env` and still reaches every
 * subprocess we spawn — while the RUNNING session keeps reading the credential
 * file it started with.
 *
 * The shape is the vendor's, for a neighbouring set of names.
 * `server-managed-settings.md#fetch-and-caching-behavior`:
 *
 *   "the startup-only selectors covered above reach the environment but don't
 *   switch the running session's credential source"
 *
 * **Read the preceding paragraph before citing that sentence for `HOME`, and
 * this is a correction to P3.143's own premise.** "The startup-only selectors
 * covered above" is defined one paragraph up as the Workload Identity
 * Federation variables plus `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR` —
 * "Claude Code reads the Workload Identity Federation variables and the
 * `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR` selectors only at startup".
 * `HOME` is in the OTHER group, and the doc gives that group a different
 * answer: "For `CLAUDE_CONFIG_DIR` and the operating-system directory
 * variables, the withholding itself is the protection". So the page does NOT
 * say Claude Code latches `HOME`; it says the withhold is all `HOME` gets.
 *
 * The latch here is therefore OURS, for the same reason the `execution`
 * category is ours: the loop is reachable through a mechanism Claude Code does
 * not have. A moved `HOME` does not merely relocate a config directory for us —
 * it relocates `~/.nessy/dp_auth_creds.json`, a file SHARED with nessy-cli
 * whose shape is nessy-cli's contract, for reads and for writes; it relocates
 * the `~` expansion that `config/sandbox-settings.ts` applies to `deniedPaths`,
 * which is the floor protecting that same file; and it is handed to the `dp`
 * subprocess that mints the token.
 *
 * ## The boundary, stated so a later reader can tell a gap from a decision
 *
 * This latch covers the session's CREDENTIAL SOURCE, the KEY that credential
 * store is encrypted under, and the in-process floor around both — nothing
 * wider. Callers converted: `auth/dp/creds-store.ts` (both creds paths),
 * `auth/dp/dp-runtime.ts` (dp's state root and the `HOME` handed to the dp
 * subprocess), `config/sandbox-settings.ts` (the `~` anchor for `deniedPaths`
 * and its siblings), and the Electron main handler that used to resolve the
 * same creds file a second time by hand (all P3.143); then
 * `credentials/backends/secure-storage.ts`'s four key derivations (P3.167),
 * `codex-responses-adapter`'s third hand-written resolution of the creds file,
 * and the Pi floor's four anchors — `server-core/pi-harness/isolation.ts`,
 * `agent/pi-harness/sandbox-permission-rules.ts`,
 * `agent/pi-harness/permission-dsl.ts`, `agent/core/path-processor.ts`
 * (P3.168).
 *
 * Every other `os.homedir()` caller in the tree — skills storage, memory
 * imports, plugin caches, heapdump paths — still follows a confirmed `HOME`,
 * and that is correct: the doc's promise is about the credential source, not
 * about every path a session touches.
 *
 * ## The secure store is a DIFFERENT failure from the creds file (P3.167)
 *
 * `credentials/backends/secure-storage.ts` keeps its file at `CONFIG_DIR`,
 * which P3.133 measured as the one path a moved `HOME` never relocates. So the
 * move does not point that backend at another store — `homedir()` feeds its KEY
 * DERIVATION, and the store answers *not found* rather than *wrong path*. A
 * user reads that as "my credentials vanished", and re-authenticating writes
 * new entries under the new key while the originals stay behind under the old
 * one. Same latch, same shape, worse consequence.
 *
 * ## Why the value is captured at import
 *
 * A lazy first-call latch would capture whatever `HOME` said at the moment of
 * the first credential read, which can be AFTER the confirming fetch releases
 * the managed value — a latch that latches the attacker's answer. Capturing at
 * module load makes the value the one the process started with, and it is the
 * pattern `config/paths.ts` already uses (`DEFAULT_CONFIG_DIR` freezes at first
 * import, which is why P3.133 measured `CONFIG_DIR` as the one path that never
 * moved).
 *
 * ## Where the implementation lives, and why it is not in this file
 *
 * In `@nessy-agent/codex-responses-adapter` `src/home-latch.ts`, re-exported
 * below. That package is the dependency ROOT of the pair — shared depends on
 * it, so it cannot depend on shared — and its `nestor-auth.ts` resolves
 * `~/.nessy/dp_auth_creds.json` by hand, the same file `getCredsPath()`
 * resolves. Hosting the module there is what lets BOTH sides read one latch.
 *
 * A second, local latch in that package was the obvious alternative and is the
 * wrong one: a latch's correctness is its capture TIME, two module-scope
 * captures happen at two different moments, and a module reached through a
 * dynamic `import()` can capture after `applyManagedEnv` has already released
 * the administrator's value. Two latches that disagree would write the shared
 * creds file under one home and read it under the other.
 *
 * Import from THIS module inside `@nessy-agent/shared` and its dependents; the
 * adapter's own sources import their local path directly.
 */

export { latchedHomeDir, relatchHomeDirForTests } from '@nessy-agent/codex-responses-adapter/home-latch';
