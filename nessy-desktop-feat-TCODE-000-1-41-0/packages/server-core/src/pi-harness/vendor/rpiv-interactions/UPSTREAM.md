# Controlled source record

- Packages: `@juicesharp/rpiv-todo`, `@juicesharp/rpiv-ask-user-question` 1.20.0
- Release source: `060373d9292aeb46aeedc23a6d818a997200a6e5`
- License: MIT; see `LICENSE`.
- Retained behavior: pure task graph/reducer and AskUser validation/state rules.
- Removed: TUI, ExtensionAPI effects, config, RPC fallback, package storage, commands, i18n and listeners.
- Sync rule: compare reducer behavior and tests at the pinned SHA before changing these files; local changes may only adapt injected Nessy storage/ports.
