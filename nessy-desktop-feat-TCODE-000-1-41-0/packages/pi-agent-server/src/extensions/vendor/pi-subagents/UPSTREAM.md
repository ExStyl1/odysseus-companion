# pi-subagents controlled reference

- Package/tag: `@gotgenes/pi-subagents` / `pi-subagents-v18.0.2`
- Commit: `0720e67ea974dbc257a333db2135b70c2b5e94c6`
- License: MIT; preserved in `LICENSE`
- Captured: 2026-07-16

The X7 state vocabulary and terminal-transition rules use the host-neutral
behavior of `src/lifecycle/subagent-state.ts` as a reference. Bounded result and
steering behavior references `src/tools/get-result-tool.ts` and
`src/tools/steer-tool.ts`. Nessy retains no copied executable source; the
equivalent transitions live in the owned `ChildSessionService` and its tests.

Removed ownership: Pi ExtensionAPI effects, TUI rendering, ambient agent
discovery, package-owned persistence, direct subprocess spawning, and the
separate upstream worktree companion. Nessy owns those boundaries through its
existing SessionManager, ToolExecutor, ProcessSupervisor, and workspace/git
services. Syncing a newer upstream version requires reviewing this record,
the ChildSessionService transition tests, H2 model-contract hashes, and the
frozen tool surface fixture; copied-source patch ceiling is zero.
