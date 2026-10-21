# Odysseus knowledge graph — local verification

2026-10-21; local source build 1.42.1-odysseus.7. No packaged/CDP pass claimed.

The integration uses the existing Graphify skill and native MCP tools (upstream Graphify 0.9.92), rather than another graph engine. The host supplies project registration, background indexing, local Obsidian discovery/export, and the UI. Native Desktop chat and model/permission controls are reused for the editing agent. A custom renderer receives bounded projections from a separate Node process; it never imports Node filesystem modules. Stock update/signing infrastructure is unchanged; integrations/desktop/manifest.json reapplies the bridge.

## Automated evidence

- Root `node --test tools/*.test.mjs`: 60 pass, 0 fail. Includes real Python/Graphify extraction, incremental file deletion, ambiguous package providers, note aliases/code fences, report-edit protection, global search/pagination and durable manual changes.
- Focused native tests: 11 pass across 4 files (knowledge/plugin routes, role skills catalog, direct-IPC API parity).
- `bun run typecheck:electron`: exit 0.
- Main, preload, renderer and asset builds succeed. Renderer has zero browser-externalized Node warnings; existing chunk-size advice remains.
- Desktop bridge `--check`: zero changes. Shared profile `sync --check`: 3663 resources, zero file changes at measurement.
- Official Python MCP SDK: initializes the Node stdio wrapper, lists 10 native Graphify tools and retrieves the real Odysseus CLI project node.
- Real CLI/Desktop/workspace graphs are present. Worker logs show changed:false and cached:true on unchanged passes. Detailed symbol graphs remain separate from the aggregate file graph.

## Native observations

The sidebar shows «База знаний» and «Чат с базой знаний». Opening the map displays three real registered projects, node/link totals, project selection, global search, pan/zoom controls and pagination. The compact overview initially displays 60 matching nodes; project/file neighborhoods and search display up to 160 nodes plus anchors, with an explicit count. This is progressive exploration, not a claim to render every node simultaneously.

Selecting Odysseus Desktop displays its filesystem evidence and its detailed MCP graph path. «Раскрыть связи» opens its documents, folders, files and shared elements. The chat tab opens the persistent native «Агент базы знаний» conversation with Graphify selected and an editable first-request instruction. Reloading reopens that same chat; no duplicate is created. No model response or paid generation was dispatched for this UI check.

Using the actual «Заметка» form saved «Общий профиль Odysseus», with README/design evidence. The local editing helper linked it to the CLI and Desktop nodes. The overlay persists independently; background merge includes it. Fixture tests cover its persistence through a fresh Graphify merge. Prior overlay versions are saved, and automatic nodes cannot be removed by the manual-edit command.

Obsidian is not installed on this machine; Markdown and native Canvas exports are checked on disk and in fixtures. No Obsidian GUI observation claimed. Vault discovery on macOS/Linux/Windows registries and fallback creation are tested. Runtime installation is local to this checkout; the shared config and installer do not embed this machine's paths.
