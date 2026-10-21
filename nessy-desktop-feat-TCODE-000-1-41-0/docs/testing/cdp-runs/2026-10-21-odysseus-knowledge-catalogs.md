# Knowledge catalogs, live refresh and evidence reader

2026-10-21, local 1.42.1-odysseus.8. No packaged/CDP/model-response pass claimed.

## Contract

A knowledge catalog groups projects; it is distinct from the folders inside a source project. My projects is the default context. Configured CLI/Desktop sources and the demonstration workspace belong to Odysseus. Users can create catalogs and move project assignments without moving source files. Independent MCP graph files and Desktop agent chat keys separate their contexts. The internal aggregate remains available for organization; this is not a filesystem ACL.

The source-folder browser displays immediate contains children, breadcrumbs and a project-scoped search. Relationships is a separate mode. Evidence documents open through a worker that validates the path against the selected catalog's graph node/adjacent edges. Markdown renders in an in-app dialog, code as text; unsupported formats offer the existing native Open in app control.

## Verification

- Root suite: 66 pass, 0 fail. Includes a real long-lived worker receiving an edit and an immediate subsequent snapshot without restart; unchanged snapshots use version markers. Catalog fixtures exclude Odysseus from user projects, retain only the selected project's files, persist moves and create separate MCP files/sources. Disabled sources stay disabled. The document reader refuses unrelated paths.
- Native focused checks: 11 pass in four files, including direct-IPC API parity. Electron typecheck and main/preload/renderer/assets builds pass. Zero browser-externalized Node warnings; existing chunk-size advice remains.
- Official MCP SDK on real graphs: get_node by exact project id does not return the Odysseus node from projects; the same exact id resolves to Node: Odysseus CLI from odysseus.
- Desktop bridge --check: zero changes.

## Native observations

Before catalog grouping, the actual project browser was driven through Odysseus Desktop → apps → electron. Only immediate subfolders/files appeared. Selecting the README document and its relationship's Read source button opened the actual apps/electron/README.md, with formatted headings, code and tables. The native external-open control was visible; an external app was not launched.

After applying catalog grouping, the Desktop opened on My projects with 0 projects / 0 nodes / 0 links; Odysseus source projects were absent. A subsequent native observation showed Odysseus selected with its three projects and the architecture note, confirming separate data views. The user was interacting with the app, so further navigation was stopped after reading fresh state. No new catalog or chat was created in the user's real profile just for UI testing; creation, movement and scoped MCP source generation were exercised in fixtures.

The persistent Node reader caches the aggregate outside Electron main. UI requests are sequential and use version markers; unchanged data does not reset layout or pan/zoom. The launcher checks indexer liveness every 15 seconds, so it can recover after a worker exit. Source indexing and view refresh are separate; a changed source file still requires its background indexing pass.
