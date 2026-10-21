---
name: "lean-build"
description: "Реализация минимального законченного изменения с повторным использованием кода и чёткой границей задачи."
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


# Lean build

Native Core's architecture-first simplicity remains mandatory. Turn feature into complete narrow outcome fitting system.

- Derive observable acceptance and explicit non-goals from request and repository.
- Trace entry point through layers owning invariants.
- Deliver coherent end-to-end path across responsible layers; never force work into one file, direct expression, or local patch.
- Reuse fitting seam. Refactor when patching duplicates behavior, weakens ownership, or hides root cause.
- Omit modes, providers, config, extensibility, and polish unless acceptance needs them.
- Add surface, dependency, service, config, or migration only for lifecycle design or acceptance; state material tradeoff.
- Keep work runnable; preserve Core safety.

Exercise path. Run focused proof. Stop when acceptance passes. Report only material omissions and trigger.
