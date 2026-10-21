---
name: "lsp-setup"
description: "Установка и настройка локального языкового сервера для диагностики, символов и переходов по коду."
disable-model-invocation: true
user-invocable: true
when_to_use: "При разработке или анализе кода, когда нужен именно этот этап процесса; вход — задача, исходники и критерии готовности."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus execution profile: local, browser and Obsidian

This installation is configured for local execution. This profile narrows the
upstream workflows below and takes precedence over their optional online modes.
Use the current Nessy agent/model, local files, installed CLI tools and libraries.
Browser interaction and the local Obsidian integration are explicitly allowed.

- Do not request, configure or use extra API keys, cloud AI providers, hosted
  rendering, SaaS MCP connections or another agent runtime to complete this skill.
- Use local inputs, cached/bundled assets and installed local engines. When web
  content is necessary, use the host's browser tools; do not replace them with a
  provider API, authenticated scraping service or non-browser cloud connector.
- Select documented offline branches without waiting for cloud sign-in. Ignore
  upstream instructions to refresh skills remotely, log into a provider, generate
  media remotely, publish through a SaaS API, or invoke a removed skill.
- Use native host tools for browser control, subagents and language servers when
  available. A local LSP/MCP adapter is allowed; a foreign agent/plugin runtime is
  not a prerequisite to install. Report missing local capability honestly.
- If the requested output cannot be produced locally, explain the missing local
  input or tool. Do not silently switch to a cloud service or claim completion.
  Installing a skill does not install its local engines or dependencies.

---


# LSP Setup

Configure the right Language Server for a project so the `lsp` MCP tools
(`diagnostics`, `goto_definition`, `find_references`, `symbols`, `rename`)
actually work. This skill is an index: detect what a project needs, install the
server, write the config, then verify with a real roundtrip.

The list of servers we ship as **builtin** is the source of truth in
`packages/lsp-tools-mcp/src/lsp/server-definitions.ts` (`BUILTIN_SERVERS` +
`LSP_INSTALL_HINTS`). The per-language references below mirror it.

---

## PHASE 0 — LANGUAGE GATE (run first)

Identify the language from the file extension, then **read the matching
reference before installing or configuring anything**.

| Extension(s) | Reference |
|---|---|
| `.ts .tsx .js .jsx .mjs .cjs .mts .cts .vue .svelte .astro` | `references/typescript/README.md` |
| `.py .pyi` | `references/python/README.md` |
| `.go` | `references/go/README.md` |
| `.rs` | `references/rust/README.md` |
| `.c .cpp .cc .cxx .h .hpp .hh .hxx` | `references/c-cpp/README.md` |
| `.java` | `references/java/README.md` |
| `.kt .kts` | `references/kotlin/README.md` |
| `.cs .razor .cshtml` | `references/csharp/README.md` |
| `.swift` | `references/swift/README.md` |
| `.rb .rake .gemspec .ru` | `references/ruby/README.md` |
| `.php` | `references/php/README.md` |
| `.dart` | `references/dart/README.md` |
| `.ex .exs` | `references/elixir/README.md` |
| `.zig .zon` | `references/zig/README.md` |
| `.lua` | `references/lua/README.md` |
| `.sh .bash .zsh .ksh` | `references/bash/README.md` |
| `.yaml .yml` | `references/yaml/README.md` |
| `.tf .tfvars` | `references/terraform/README.md` |
| `.hs .lhs` | `references/haskell/README.md` |
| `.jl` | `references/julia/README.md` |

---

## WORKFLOW — detect → install → configure → verify

### 1. Detect

Scan the project to see which languages are present and whether each server is
installed and configured:

```bash
bun scripts/detect-lsp.ts <projectDir>      # human report (default: cwd)
bun scripts/detect-lsp.ts <projectDir> --json
```

For each detected language it prints the builtin server id, the executable it
needs on `PATH`, whether that executable is installed, an install hint, and
whether a project config file already references it.

### 2. Install

Open `references/<language>/README.md` and run the install command for your OS.
Then confirm the executable resolves:

```bash
command -v <server-executable>   # e.g. typescript-language-server, gopls, rust-analyzer
```

### 3. Configure

Most builtin servers need **no config** — they are resolved automatically by
file extension. Write config only to: pick between competing servers, set a
`priority`, pass `initialization` options, override `extensions`, set `env`, or
`disable` a server.

Two project-scoped config files, **identical JSON shape**:

- Codex harness → `.codex/lsp-client.json` (user: `~/.codex/lsp-client.json`)
- OpenCode/omo harness → `.opencode/lsp.json` (also `.omo/lsp.json`)

```jsonc
{
  "lsp": {
    "<server-id>": {
      "command": ["<bin>", "<args>"],   // optional for builtin ids (supplied automatically)
      "extensions": [".ext"],            // optional override
      "priority": 100,                    // higher wins when several servers match an extension
      "initialization": { },              // server-specific initializationOptions
      "env": { "KEY": "value" },          // optional
      "disabled": false                   // set true to turn a server off
    }
  }
}
```

Rules enforced by `config-loader.ts`:

- In a **project** config (`.codex/lsp-client.json`, `.opencode/lsp.json`) an
  entry whose id is a **builtin** server inherits `command` automatically — you
  only override `extensions` / `priority` / `initialization`. A non-builtin id
  in a project config is **ignored**.
- To define a **fully custom** (non-builtin) server with its own `command`, put
  it in the **user** config (`~/.codex/lsp-client.json`, or the path set by
  `LSP_TOOLS_MCP_USER_CONFIG`), where `command` + `extensions` are honored.
- Project entries win over user entries; both win over builtin defaults.

Each language reference gives a ready-to-paste snippet.

### 4. Verify

Run a real diagnostics roundtrip against a source file. This spawns the server,
opens the file, requests diagnostics, and reports `OK`/`FAIL`:

```bash
bun scripts/verify-lsp.ts <path/to/file.ext>
bun scripts/verify-lsp.ts <file> --timeout=90000
```

`OK` = the server started and answered. `FAIL: language server not installed`
= go back to step 2. Other `FAIL` text carries the server/startup error.
`SKIP` = the engine source could not be located; run from inside the omo
repo/worktree, or call the `lsp` MCP `diagnostics` tool directly.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/detect-lsp.ts` | Scan a directory; per detected language report server id, install status, install hint, config status. `--json` for machine output. |
| `scripts/verify-lsp.ts` | Real LSP diagnostics roundtrip for one file via the `lsp-tools-mcp` engine; `OK`/`FAIL`/`SKIP` + exit code 0/1/3. |
| `scripts/lsp-server-table.ts` | Embedded snapshot of the primary builtin server per language (mirrors `server-definitions.ts`). |

Run with [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`.
