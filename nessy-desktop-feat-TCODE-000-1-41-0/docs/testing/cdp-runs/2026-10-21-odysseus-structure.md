# Odysseus repository structure and portable launchers

2026-10-21, local 1.42.1-odysseus.10. Native UI observations; no CDP, packaged update or model-response pass claimed.

## Scope

The user explicitly selected folder/code structure over interface redesign. CLI/Desktop checkout locations and source project identities stay fixed. Internal integration libraries are grouped under tools/personal, tools/profile, tools/knowledge, tools/cli and tools/skills. Tests live under tests/<domain>. Desktop templates mirror the native main/shared/renderer layout, with binary/theme resources under assets. The HTML catalog template has its own integrations/catalog location.

Graph overlay persistence, graph cache, projections and evidence reading are separate modules. The existing knowledge-ui entry point still exports its prior public functions and handles CLI/IPC requests. The renderer layout is extracted without changing its calculations. Existing compiled Desktop imports and Graphify worker entry paths retain compatibility wrappers. Code is formatted using checked-in editor/Prettier conventions, excluding upstream checkouts, shared imported resources and runtime/generated data.

The renamed Odysseus .command files resolve their own location and invoke a shared zsh launcher. It locates an existing Node.js 22+ using an explicit override, PATH, common install locations or nvm. It never installs a runtime. The real source CLI entry and argument forwarding are unchanged.

## Verification

- Root integration suite: 77 pass, 0 fail, 0 skipped. Includes persistent graph-worker reads/edits, catalog separation, Obsidian exchange, Python graph merge, personal-profile conflict/encryption behavior and real CLI startup. The new actual launcher fixture canonicalizes macOS temporary paths; the existing symlink guard remains intact.
- Native tests: 13 pass across five files, including pointer regression, routes, skills and direct-IPC API parity.
- Electron typecheck and main/preload/renderer/assets builds pass. Renderer build completed in 30.11 seconds. No browser-externalized Node warnings; existing chunk-size advice remains.
- Desktop bridge dry run: zero changes. Shared profile dry run: 3663 resources, one project, zero file changes. git diff --check passes.
- Independent read-only review checked normalized behavior changes, all relative imports, compiled-main entry points, generator paths and the Python compatibility wrapper; no actionable issue found.
- Native Downloads Desktop starts with the rebuilt renderer. The knowledge overview shows three projects; entering the CLI project displays its folders/files, then returning to the overview succeeds without an error/reload screen.

## Documentation

Root README now provides navigation, actual Odysseus launcher names and current synchronization behavior. docs/development.md explains folder responsibilities, public entry-point compatibility, generation, formatting and test commands. The native CLI reference includes the portable launcher instructions.
