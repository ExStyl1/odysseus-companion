---
name: "artifact-publish"
description: "Публикация подготовленного артефакта корпоративными инструментами по явному запросу."
allowed-tools: "Bash(artifact-publish:*), Bash(npx -y @loyalty-personalization/artifact-publish:*)"
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «brainstorm» → «brainstorming», режим «brainstorm». Старое имя не является отдельной командой.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# artifact-publish

Publish a self-contained HTML or Markdown page to the internal artifact service and get back a link. `npx -y @loyalty-personalization/artifact-publish` runs the current version. Publishing and management use the current `dp auth` identity.

Before the first run, configure npm access and the registry for this package scope:

```bash
dp auth login
dp artifacts npm configure
npm config set --location=user '@loyalty-personalization:registry' 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/'
```

`dp artifacts npm configure` sets npm authentication. The scoped registry setting lets `npx` find this package in `npm-all` without changing the registry for other packages.

## Start here

This file is a discovery stub, not the usage guide. Before running any `artifact-publish` command, load the actual workflow content from the CLI:

```bash
npx -y @loyalty-personalization/artifact-publish skill get core
```

## Specialized skills

Load a specialized skill before writing polished content:

```bash
npx -y @loyalty-personalization/artifact-publish skill get design            # design calibration, AI-look defaults to avoid
npx -y @loyalty-personalization/artifact-publish skill get dataviz           # before the first line of chart/dashboard code
npx -y @loyalty-personalization/artifact-publish skill get frontend-design   # for a page that's really a piece of UI
```

Run `npx -y @loyalty-personalization/artifact-publish skill list` to see everything available on the installed version.

Use `claim ID_OR_URL --edit-token TOKEN` once to assign an old artifact to the current DP identity. Use `list`, `rename` and `delete` to manage owned artifacts.
