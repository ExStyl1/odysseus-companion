---
name: "research"
description: "Исследование конкретного вопроса по первичным источникам с сохранением выводов в Markdown."
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


Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
