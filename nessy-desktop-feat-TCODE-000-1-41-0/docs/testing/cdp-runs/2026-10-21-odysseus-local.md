# Odysseus local source build, 2026-10-21

Version: 1.42.1-odysseus.1. This is a local source integration, not a signed release rehearsal.

- Root synchronization tests: 46 passing, covering conflict preservation, partial writes, active source export, attachment archives, private credential rotation, idempotence, system appearance, dry-run and concurrent native writes. Desktop integration reinstall tests validate an independent source replacement and fail before writing an incompatible source seam.
- Focused native tests: 5 passing across 3 files, including the real Desktop transcript reader and provider/auth validator, trusted-window checks, busy-session refusal and CLI handoff with a quoted project path. The OS open call is stubbed in this test; it does not open a real terminal.
- Electron typecheck passed. Main, preload and renderer builds passed. Renderer emitted no browser-externalized Node warnings. Main retains two pre-existing import.meta/CJS warnings in unrelated modules.
- Normal-profile dry-run: no conflicts or unsupported resources; four configuration/state files required initial normalization. Apply succeeded with private backups.
- Native accessibility observation confirmed Russian sidebar actions “Открыть в CLI” and “Синхронизировать CLI ↔ Desktop”. App relaunched after fixing system-theme baseline oscillation. Latest automatic sync: zero changes, zero conflicts, zero deferred records.
- System Terminal opening remains unconfirmed in this agent environment: UI interaction timed out and the terminal is outside the available permitted UI surface. No Terminal automation workaround was used. The final handler bounds OS launch confirmation to 15 seconds and returns a visible failure instead of keeping the button pending.
- No model requests were sent by the integration tests. Real-profile model credential exchange could not be exercised because there are no configured compatible model connections in these profiles. Credential encryption/rotation was exercised only with disposable fixture strings.
- Permissions were not changed for the audit. Chat import creates normal/default permissions and never transfers grants, tools, or SDK runtime anchors.

CDP driver coverage is still owed; these results are native UI observation and focused automated checks, not a CDP pass.
