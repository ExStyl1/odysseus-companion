# Graph pointer stability and two-way Obsidian exchange

2026-10-21, local 1.42.1-odysseus.9. Native UI observations, not a CDP or packaged-install pass. Obsidian itself is not installed on this host; native Markdown/wiki-link files were verified on disk.

## Finding and implementation

The graph's deferred React updater read `drag.current!.px` and other mutable coordinates. Pointer release/cancellation cleared that ref before an updater could execute, allowing a null dereference to reach the application error boundary. The pan controller now computes immutable coordinates before scheduling an update, coalesces movement into one animation frame and cancels pending movement on view changes/unmount. Local storage failures no longer throw through navigation. Switching context also closes stale edit/source dialogs; link submission validates its selected endpoint.

The existing Obsidian integration only imported ordinary vault notes and protected generated reports. It had no native two-way catalog exchange. The new trusted direct IPC runs a dedicated Node process, independently of the knowledge reader and Electron main thread. Concurrent button presses share one operation. All catalogs export every projected graph node as native Markdown with explicit outgoing wiki links. Catalog boundaries and existing vault discovery remain intact.

A common-base comparison merges label, description and manual links. Source-derived relations remain source-derived; user descriptions of code nodes are persistent overlay annotations, not source-code edits. Concurrent differences preserve both versions and produce visible conflicts. Native source/MCP aggregation applies annotations too. Stable IDs survive renames within a catalog. New ordinary Markdown files and their known local wiki links import into manual knowledge. Deleting a generated file restores it; missing graph nodes never cause deletion of user notes. Prior changed files and overlays are backed up. Unknown formatting, duplicate IDs, symbolic links and concurrent edits are rejected without overwriting the affected note. Synchronization is explicitly on demand, not a continuous watcher of the exchange folder.

## Verification

- Root suite: 72 pass, 0 fail. Six exchange fixtures cover both directions, idle mtimes, conflicts, renamed notes, added/removed manual links, preserved source relations, annotations, new notes/wiki links, hidden source names, CRLF, deletion recovery and removal of managed identity. Real Python merge checks annotation persistence.
- Native suite: 13 pass in 5 files, including two pointer regression tests: 100 moves coalesce into one frame; a deferred update executes safely after release; 100 view cancellations leave no queued frames; zero-width surfaces are ignored. Routes, translated skills and direct IPC API parity remain green.
- Electron typecheck and main/preload/renderer/assets builds pass. No browser-externalized Node warnings. Existing large-chunk advice remains.
- Desktop bridge `--check`: 0 changes. Profile sync preview: 3663 resources, 1 project, 0 file changes.
- Actual vault: 3 catalogs, approximately 16000 graph nodes exported. After initial export and normalization, repeated synchronization returned imported=0, exported=0, conflicts=[] and preserved mtimes.
- Running Downloads Desktop reports version .9. Native button visibly showed synchronization and then: 3 catalogs, 0 imports, 9 files written, 0 conflicts (the nine files reflected source updates). Three native drag gestures and three Sources→Knowledge round trips left the map functional, with no reload prompt. The deterministic pointer test covers the release/updater race more precisely than native gesture timing.

## Limits

Automatic code relations must be corrected in their source files. Deletion of a generated Markdown file is not a request to delete knowledge. The exchange folder is synchronized by the button/CLI; ordinary vault notes retain the previous background import. External Obsidian GUI rendering and large-vault stress testing on other machines are not claimed.
