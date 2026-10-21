---
name: "odysseus-workspace"
description: "Работа с общим каталогом MCP, навыков и правил Nessy CLI и Desktop и объяснение синхронизации Odysseus."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда нужно понять общие ресурсы Nessy CLI/Desktop, проверить их синхронизацию или независимое обновление приложений."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

This project uses Odysseus to share MCP definitions, skills, agent definitions
and Markdown rules between Nessy CLI and Nessy Desktop.

The project projections are `.mcp.json`, `.agents/skills`, `.nessy/agents`,
`.nessy-agent/agents`, `.nessy/rules` and `.nessy-agent/rules`.

Changes to existing managed resources can be synchronized back to the common
catalog with the Odysseus `sync` command. New resources need an explicit import.
If two copies have changed differently, resolve the conflict before syncing.

Both applications use their own updater. Credentials, permission decisions,
chat history and app-specific preferences remain separate. Sharing an MCP
definition never grants permission to execute it.
